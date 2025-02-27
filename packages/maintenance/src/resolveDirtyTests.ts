/*!
 * This scripts ensures that files annotated with @forbiddenImports don't import
 * anything they are not supposed to.
 */

import crypto from "crypto";
import execa from "execa";
import fs from "fs";
import path from "path";
import ts from "typescript";
import { loadTSConfig, projectRoot, repoRoot } from "./tsAPITools";

const reportFile = path.join(repoRoot, ".tmp", "dirty-tests.json");

function getExternalModuleName(node: ts.Node): ts.Expression | undefined {
	if (
		ts.isImportEqualsDeclaration(node) &&
		ts.isExternalModuleReference(node.moduleReference)
	) {
		return node.moduleReference.expression;
	} else if (ts.isImportDeclaration(node)) {
		// Only return import declarations where there is at least one non-typeonly import specifier
		if (!node.importClause) {
			// import "bar"
			return node.moduleSpecifier;
		} else if (
			!node.importClause.isTypeOnly &&
			// import foo from "bar"
			(!node.importClause.namedBindings ||
				// import * as foo from "bar"
				ts.isNamespaceImport(node.importClause.namedBindings) ||
				// import {foo, type baz} from "bar"
				(ts.isNamedImports(node.importClause.namedBindings) &&
					node.importClause.namedBindings.elements.some(
						(e) => !e.isTypeOnly,
					)))
		) {
			return node.moduleSpecifier;
		}
	} else if (ts.isExportDeclaration(node)) {
		// Only return export declarations where there is at least one non-typeonly export specifier
		if (
			!node.isTypeOnly &&
			// export * from "bar"
			(!node.exportClause ||
				// export * as foo from "bar"
				ts.isNamespaceExport(node.exportClause) ||
				// export {foo, type baz} from "bar"
				(ts.isNamedExports(node.exportClause) &&
					node.exportClause.elements.some((e) => !e.isTypeOnly)))
		) {
			return node.moduleSpecifier;
		}
	}
}

interface ResolvedImport {
	name: string;
	line: number;
	sourceFile: ts.SourceFile;
}

function getImports(
	sourceFile: ts.SourceFile,
	checker: ts.TypeChecker,
): ResolvedImport[] {
	const output: ResolvedImport[] = [];
	ts.forEachChild(sourceFile, (node) => {
		// Vist top-level import nodes
		const moduleNameExpr = getExternalModuleName(node);
		// if they have a name, that is a string, i.e. not alias definition `import x = y`
		if (
			moduleNameExpr &&
			moduleNameExpr.kind === ts.SyntaxKind.StringLiteral
		) {
			// Ask the checker about the "symbol: for this module name
			// it would be undefined if the module was not found (i.e. error)
			const moduleSymbol = checker.getSymbolAtLocation(moduleNameExpr);
			const file = moduleSymbol?.getDeclarations()?.[0]?.getSourceFile();
			if (file) {
				output.push({
					name: moduleNameExpr.getText(sourceFile),
					line:
						ts.getLineAndCharacterOfPosition(
							sourceFile,
							moduleNameExpr.getStart(),
						).line + 1,
					sourceFile: file,
				});
			}
		}
	});
	return output;
}

interface LinterContext {
	program: ts.Program;
	resolvedSourceFiles: Map<string, string>;
}

/** Given a definition file, this tries to resolve the original source file */
function resolveSourceFileFromDefinition(
	context: LinterContext,
	file: ts.SourceFile,
): ts.SourceFile {
	if (context.resolvedSourceFiles.has(file.fileName)) {
		return (
			context.program.getSourceFile(
				context.resolvedSourceFiles.get(file.fileName)!,
			) ?? file
		);
	}

	function bail() {
		context.resolvedSourceFiles.set(file.fileName, file.fileName);
		return file;
	}

	const sourceMappingURL = /^\/\/# sourceMappingURL=(.*)$/gm.exec(
		file.text,
	)?.[1];
	if (!sourceMappingURL) return file;

	const mapPath = path.resolve(path.dirname(file.fileName), sourceMappingURL);
	let map: any;
	try {
		map = JSON.parse(fs.readFileSync(mapPath, "utf8"));
	} catch {
		return bail();
	}

	let originalFileName = map.sources?.[0];
	if (typeof originalFileName !== "string") {
		return bail();
	}

	originalFileName = path.resolve(
		path.dirname(file.fileName),
		originalFileName,
	);
	const originalFile = context.program.getSourceFile(originalFileName);
	if (originalFile) {
		context.resolvedSourceFiles.set(file.fileName, originalFile.fileName);
		return originalFile;
	}

	return bail();
}

function relativeToProject(filename: string): string {
	return path.relative(projectRoot, filename).replace(/\\/g, "/");
}

function isExternalModule(imp: ResolvedImport): boolean {
	return imp.sourceFile.fileName.includes("node_modules");
}

function report(
	diffHash: string,
	changes: Record<string, string[]> | null,
): void {
	fs.mkdirSync(path.dirname(reportFile), { recursive: true });
	fs.writeFileSync(
		reportFile,
		JSON.stringify({ diffHash, changes }, null, 2),
	);
}

function hash(input: string): string {
	const hasher = crypto.createHash("sha256");
	hasher.update(input);
	return hasher.digest("hex");
}

async function getDiffOutput(): Promise<string> {
	const gitDiffOutput = (await execa("git", ["diff", "--name-only", "HEAD"]))
		.stdout;
	return gitDiffOutput;
}

export async function resolveDirtyTests(): Promise<void> {
	// Use git to figure out which files have changed
	const gitDiffOutput = await getDiffOutput();
	const gitDiffHash = hash(gitDiffOutput);
	const changedFiles = gitDiffOutput
		.split("\n")
		.map((file) => file.trim())
		.filter(Boolean);

	if (!changedFiles) {
		// console.log("No changed files");
		report(gitDiffHash, null);
		return;
	}

	// Create a Program to represent the project, then pull out the
	// source file to parse its AST.

	const tsConfig = loadTSConfig(undefined, false);
	const program = ts.createProgram(tsConfig.fileNames, {
		...tsConfig.options,
		preserveSymlinks: false,
	});
	const checker = program.getTypeChecker();

	const context: LinterContext = {
		program,
		resolvedSourceFiles: new Map(),
	};

	const dirtySourceFiles = new Set<string>(changedFiles);

	// Scan all source files
	files: for (const sourceFile of program.getSourceFiles()) {
		const relativePath = relativeToProject(sourceFile.fileName);

		// Only look at files inside the packages directory
		if (!relativePath.startsWith("packages/")) continue;
		if (!relativePath.endsWith(".test.ts")) continue;

		// Resolve the import tree
		const visitedSourceFiles = new Set<string>();
		const todo: { file: ts.SourceFile; importStack: string[] }[] = [
			{ file: sourceFile, importStack: [] },
		];
		while (todo.length > 0) {
			const current = todo.shift()!;
			visitedSourceFiles.add(current.file.fileName);
			const importStack = [
				...current.importStack,
				relativeToProject(current.file.fileName),
			];

			// TODO: Try to eliminate barrel files from the dependency tree
			const imports = getImports(current.file, checker);
			for (const imp of imports) {
				if (isExternalModule(imp)) continue;

				// try to resolve the original source file for declaration files
				const next: ts.SourceFile = imp.sourceFile.isDeclarationFile
					? resolveSourceFileFromDefinition(context, imp.sourceFile)
					: imp.sourceFile;

				const nextRelativeToProject = relativeToProject(next.fileName);
				if (dirtySourceFiles.has(nextRelativeToProject)) {
					// The file references a changed file, so the entire import stack
					// has to be considered dirty
					for (const file of importStack) {
						dirtySourceFiles.add(file);
					}
				} else if (!visitedSourceFiles.has(next.fileName)) {
					todo.push({
						file: next,
						importStack,
					});
				}
			}
		}
	}

	const dirtyTests = [...dirtySourceFiles].filter((file) =>
		file.endsWith(".test.ts"),
	);

	const testsByPackage: Record<string, string[]> = {};

	for (const file of dirtyTests) {
		const parts = file.split("/");
		const prefix = parts.slice(0, 2).join("/");
		const relativeToPackage = parts.slice(2).join("/");
		if (!testsByPackage[prefix]) {
			testsByPackage[prefix] = [];
		}
		testsByPackage[prefix].push(relativeToPackage);
	}

	report(gitDiffHash, testsByPackage);
}

async function runDirtyTests(): Promise<void> {
	const gitDiffOutput = await getDiffOutput();
	const gitDiffHash = hash(gitDiffOutput);

	let report: { diffHash: string; changes: Record<string, string[]> };
	try {
		report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
	} catch {
		console.error("Dirty tests not resolved yet");
		process.exit(1);
	}

	if (report.diffHash !== gitDiffHash) {
		console.error("Dirty tests are out of date");
		process.exit(1);
	}

	const projectFolder = path.relative(repoRoot, projectRoot);
	const dirtyTests = report.changes[projectFolder];
	if (!dirtyTests || !dirtyTests.length) {
		console.log(`No dirty tests in ${projectFolder || "root dir"}`);
		return;
	}

	// Run the dirty tests
	console.log(
		`Executing ${dirtyTests.length} dirty tests in ${projectFolder}...`,
	);
	await execa("yarn", ["run", "test:ts", ...dirtyTests], {
		stdio: "inherit",
	});
}

if (require.main === module) {
	const args = process.argv.slice(2);
	if (args.includes("--run")) {
		runDirtyTests()
			.then(() => process.exit(0))
			.catch(() => process.exit(1));
	} else {
		resolveDirtyTests()
			.then(() => process.exit(0))
			.catch(() => process.exit(1));
	}
}

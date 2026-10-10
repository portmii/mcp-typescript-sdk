import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'portmii-mcp-package-'));

try {
	const pack = run(
		'npm',
		['pack', '--ignore-scripts', '--json', '--pack-destination', temporaryDirectory],
		process.cwd()
	);
	const [{ filename }] = JSON.parse(pack);
	const tarball = join(temporaryDirectory, filename);
	await writeFile(join(temporaryDirectory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
	run('npm', ['install', '--ignore-scripts', tarball], temporaryDirectory);
	run(
		'node',
		[
			'--input-type=module',
			'-e',
			"const sdk=await import('@portmii/mcp'); if(!sdk.createPortmii||!sdk.PortmiiError) process.exit(1);"
		],
		temporaryDirectory
	);
	run(
		'node',
		[
			'--input-type=commonjs',
			'-e',
			"const sdk=require('@portmii/mcp'); if(!sdk.createPortmii||!sdk.PortmiiError) process.exit(1);"
		],
		temporaryDirectory
	);
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}

function run(command, args, cwd) {
	const useNpmCli = command === 'npm' && process.env.npm_execpath;
	const executable = useNpmCli || command === 'node' ? process.execPath : command;
	const finalArgs = useNpmCli ? [process.env.npm_execpath, ...args] : args;
	const result = spawnSync(executable, finalArgs, { cwd, encoding: 'utf8', shell: false });
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(' ')} failed\n${String(result.error ?? '')}\n${result.stdout}\n${result.stderr}`
		);
	}
	return result.stdout;
}

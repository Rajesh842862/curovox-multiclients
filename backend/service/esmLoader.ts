/**
 * The backend is compiled as CommonJS, where TypeScript rewrites `import()` to
 * `require()`. Some TTS dependencies publish separate ESM and CommonJS builds;
 * the ESM-only MP3 encoder must be loaded through a real native dynamic import.
 */
export function importEsm<T>(specifier: string): Promise<T> {
	const nativeImport = new Function("specifier", "return import(specifier)") as (
		specifier: string
	) => Promise<T>;

	return nativeImport(specifier);
}

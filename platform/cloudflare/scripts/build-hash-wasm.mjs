import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const sourcePath = fileURLToPath(new URL("../node_modules/hash-wasm/dist/index.esm.js", import.meta.url));
const outputDirectory = fileURLToPath(new URL("../.worker-generated/", import.meta.url));
const source = await readFile(sourcePath, "utf8");

function embeddedWasm(name) {
    const match = source.match(new RegExp(`var name\\$[a-z] = "${name}";\\nvar data\\$[a-z] = "([A-Za-z0-9+/=]+)";`));
    if (!match) throw new Error(`Unable to locate embedded ${name} WASM in hash-wasm.`);
    return Buffer.from(match[1], "base64");
}

const compileBlock = `                const asm = decodeBase64(binary.data);
                const promise = WebAssembly.compile(asm);
                wasmModuleCache.set(binary.name, promise);`;
const staticBlock = `                const module = binary.name === "argon2"
                    ? argon2Module
                    : binary.name === "blake2b"
                        ? blake2bModule
                        : null;
                if (!module) throw new Error(\`Unsupported static WASM module: \${binary.name}\`);
                wasmModuleCache.set(binary.name, Promise.resolve(module));`;
if (!source.includes(compileBlock)) throw new Error("hash-wasm loader no longer matches the static-WASM patch.");

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
    writeFile(`${outputDirectory}/argon2.wasm`, embeddedWasm("argon2")),
    writeFile(`${outputDirectory}/blake2b.wasm`, embeddedWasm("blake2b")),
    writeFile(
        `${outputDirectory}/hash-wasm-worker.mjs`,
        `import argon2Module from "./argon2.wasm";\nimport blake2bModule from "./blake2b.wasm";\n\n`
            + source.replace(compileBlock, staticBlock),
    ),
]);
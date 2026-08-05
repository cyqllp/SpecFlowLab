#!/usr/bin/env node

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import "../../src/lib/parser-core.js";
import {
  hydrateProjectArchive,
  readProjectArchive,
} from "../../src/lib/project-archive.js";
import { createOriginBundle } from "../../src/lib/origin-bundle.js";

const Parser = globalThis.SpecFlowLabParser;

try {
  const { input, output, overwrite } = parseArguments(process.argv.slice(2));
  const inputPath = resolve(input);
  const outputPath = resolve(output || input.replace(/\.sflproj$/i, ".sflorigin"));

  if (!existsSync(inputPath) || !statSync(inputPath).isFile()) {
    throw new Error(`Input project does not exist: ${inputPath}`);
  }
  if (existsSync(outputPath) && !overwrite) {
    throw new Error(`Output already exists (pass --overwrite to replace it): ${outputPath}`);
  }

  const archived = readProjectArchive(readFileSync(inputPath));
  const project = hydrateProjectArchive(archived, Parser);
  const bundle = createOriginBundle(project);
  writeFileSync(outputPath, bundle);

  process.stdout.write(`${JSON.stringify({
    status: "converted",
    input: inputPath,
    output: outputPath,
    bytes: bundle.byteLength,
    datasets: project.datasets.length,
    fittedDatasets: project.datasets.filter((dataset) => dataset.fit).length,
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`SpecFlowLab Origin bundle export failed: ${error.message}\n`);
  process.exitCode = 2;
}

function parseArguments(args) {
  const positional = [];
  let overwrite = false;
  args.forEach((argument) => {
    if (argument === "--overwrite") overwrite = true;
    else if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    else positional.push(argument);
  });
  if (!positional.length || positional.length > 2) {
    throw new Error(
      "Usage: node export-origin-bundle.mjs INPUT.sflproj [OUTPUT.sflorigin] [--overwrite]",
    );
  }
  return {
    input: positional[0],
    output: positional[1],
    overwrite,
  };
}

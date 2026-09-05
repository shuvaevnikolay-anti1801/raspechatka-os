import { copyFile, mkdir, rm } from "node:fs/promises";

const source = new URL("../../raspechatka/public/frontend/index.html", import.meta.url);
const targetDirectory = new URL("../../raspechatka/www/", import.meta.url);
const target = new URL("../../raspechatka/www/raspechatka.html", import.meta.url);

await mkdir(targetDirectory, { recursive: true });
await copyFile(source, target);
await rm(source);

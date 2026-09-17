/**
 * Kopiert die Modelldatenbanken nach dist - tsc kopiert nur TypeScript-Ausgaben,
 * die JSON-Dateien liest der Katalog aber zur Laufzeit neben dem Modul.
 */
import { cp, mkdir } from "node:fs/promises";

await mkdir("dist/sources/data", { recursive: true });
await cp("src/sources/data", "dist/sources/data", { recursive: true });
console.log("Modelldatenbanken nach dist/sources/data kopiert.");

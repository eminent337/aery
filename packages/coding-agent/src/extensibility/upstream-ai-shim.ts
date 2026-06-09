/**
 * Compatibility shim for legacy extensions importing the package root of
 * `@aryee337/aery-ai` (or one of its aliased scopes like historical aliased scopes
 * or `@aryee337/aery-ai`).
 *
 * aery-ai 15.1.0 removed the historical TypeBox root exports (`Type`, plus the
 * runtime-relevant half of the `Static`/`TSchema` pair) from the package
 * entrypoint. Legacy extensions still author parameter schemas as
 * `Type.Object({ ... })`, so this file is served by `upstream-compat.ts` in
 * place of the real aery-ai entrypoint whenever a legacy extension imports the
 * bare package root. Subpath imports (`@aryee337/aery-ai/utils/oauth`, etc.)
 * continue to resolve directly against the bundled aery-ai package.
 *
 * The `Type` runtime is borrowed from the Zod-backed TypeBox shim that
 * already serves bare `@sinclair/typebox` imports for the same extension
 * class, keeping the legacy-compat surface internally consistent.
 *
 * Type-level `Static` and `TSchema` continue to come from aery-ai's own
 * `types.ts` via the `export *` below — aery-ai still exports both as types,
 * only the runtime `Type` builder was removed.
 */

export * from "@aryee337/aery-ai";
export { Type } from "./typebox";

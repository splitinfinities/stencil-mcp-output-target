// The bundle's stand-in for `@modelcontextprotocol/server/_shims` (scripts/bundle.mjs aliases it).
// The SDK's Node shim makes Ajv the default validator, and the import alone bundles Ajv,
// ajv-formats, fast-uri, fast-deep-equal and json-schema-traverse (about 225 KB, five notices).
// The runtime passes its own validator everywhere (validator.ts), so the default is never built.
export { default as process } from 'node:process';
export { CfWorkerJsonSchemaValidator as DefaultJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker';

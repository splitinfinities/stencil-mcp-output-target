import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker';

/**
 * Checks tool and prompt arguments and tool results. @cfworker/json-schema (MIT, one notice,
 * 42 KB) instead of the SDK's default Ajv: the schemas are this runtime's own plain JSON Schema,
 * so Ajv's compiler, formats and URI resolver buy nothing.
 */
export const validator = new CfWorkerJsonSchemaValidator();

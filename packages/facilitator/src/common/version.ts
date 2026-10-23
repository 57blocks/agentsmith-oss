// tsc copies package.json to dist/package.json, so this path resolves from both src/ and dist/src/.
import packageJson from '../../package.json' with { type: 'json' };

/** The facilitator's release version, from its package.json. */
export const SERVICE_VERSION: string = packageJson.version;

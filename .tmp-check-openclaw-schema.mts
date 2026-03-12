import { buildConfigSchema, lookupConfigSchema } from './src/config/schema.ts';
import { validateConfigObjectWithPlugins } from './src/config/config.ts';

const s = buildConfigSchema({
  plugins: [
    {
      id: 'openclaw-mem0',
      configSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: ['persistent', 'ephemeral'] },
          userId: { type: 'string' },
          autoRecall: { type: 'boolean' },
          oss: { type: 'boolean' },
        },
        required: ['mode'],
      },
    },
  ],
});

const entriesNode = s.schema?.properties?.plugins?.properties?.entries as Record<string, unknown>;
const pluginSchema = entriesNode?.properties?.['openclaw-mem0'] as Record<string, unknown>;
console.log('entries additional', JSON.stringify(entriesNode?.additionalProperties));
console.log('plugin properties', Object.keys((pluginSchema?.properties as Record<string, unknown>) ?? {}));
console.log('plugin additionalProperties', JSON.stringify(pluginSchema?.additionalProperties));
console.log('lookup config', JSON.stringify(lookupConfigSchema(s, 'plugins.entries.openclaw-mem0')));

const configRoot = {
  agents: { list: [{ id: 'pi' }] },
  plugins: {
    enabled: true,
    entries: {
      'openclaw-mem0': {
        mode: 'persistent',
        userId: 'user',
        autoRecall: true,
        oss: false,
      },
    },
  },
};
const validation = validateConfigObjectWithPlugins(configRoot as never);
console.log('validation ok', validation.ok);
if (!validation.ok) {
  console.log('issues', validation.issues);
}

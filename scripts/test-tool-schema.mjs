import './offline-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildToolDefinition, buildStatusToolDefinition, buildConfigToolDefinition, buildSayToolDefinition } from '../lib/core.js';
import { managementTools } from '../lib/management.js';
import { historyTools } from '../lib/history.js';
import { catalogTools } from '../lib/model-catalog.js';
import { selectionTools } from '../lib/selection-audit.js';
import { quotaTools } from '../lib/quota-tools.js';
import { supervisionTools } from '../lib/supervision.js';

// Host author DSL contract: property-level required:boolean, and explicit
// additionalProperties for object values. Raw JSON Schema required arrays are
// invalid here, even though they are valid in the compiled wire schema.
const annotations = ['description', 'title', 'default', 'examples'];
function value(node, location, property = false) {
  assert.ok(node && typeof node === 'object' && !Array.isArray(node), location);
  if ('required' in node) assert.ok(property && typeof node.required === 'boolean', location + '.required must be property-level boolean');
  const allowed = [...annotations, ...(property ? ['required'] : [])];
  if ('oneOf' in node) {
    allowed.push('oneOf'); assert.ok(!('type' in node) && Array.isArray(node.oneOf) && node.oneOf.length >= 2, location);
    node.oneOf.forEach((item, i) => value(item, location + '.oneOf.' + i));
  } else {
    allowed.push('type');
    assert.ok(['json', 'object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(node.type), location);
    if (node.type === 'object') {
      allowed.push('properties', 'additionalProperties');
      assert.equal(typeof node.additionalProperties, 'boolean', location + '.additionalProperties');
      for (const [key, item] of Object.entries(node.properties || {})) value(item, location + '.properties.' + key, true);
    } else if (node.type === 'array') {
      allowed.push('items'); if (node.items) value(node.items, location + '.items');
    } else if (node.type !== 'json') allowed.push('enum', 'const');
  }
  for (const key of Object.keys(node)) assert.ok(allowed.includes(key), location + ': unsupported author key ' + key);
}
const options = { defineTool: d => d, resolveCwd: () => null };
const definitions = [buildToolDefinition(options), buildStatusToolDefinition(options), buildConfigToolDefinition(options), buildSayToolDefinition(options),
  ...managementTools(options), ...historyTools(options), ...catalogTools(options), ...selectionTools(options), ...quotaTools(options), ...supervisionTools(options)];
const expected = JSON.parse(fs.readFileSync(new URL('../dsh.plugin.json', import.meta.url))).contributes.tools.filter(name => name !== 'codex_quota_resume');
const run=definitions.find(d=>d.name==='codex_run');
assert.equal(Object.hasOwn(run.parameters,'timeout_ms'),false);
assert.equal(run.parameters.budget_ms.type,'number');
assert.ok(run.parameters.budget_ms.description.includes('defaultBudgetMs'));
assert.equal(definitions.find(d=>d.name==='codex_quota').parameters.timeout_ms.type,'number','quota RPC timeout remains independent');
assert.deepEqual(definitions.map(d => d.name).sort(), expected.sort());
for (const definition of definitions) {
  for (const [key, node] of Object.entries(definition.parameters)) value(node, definition.name + '.' + key, true);
  value(definition.output.schema, definition.name + '.output');
}
assert.throws(() => value({ type: 'object', additionalProperties: false, required: ['id'] }, 'raw-json-schema'), /required/);
assert.throws(() => value({ type: 'object', properties: {} }, 'implicit-additional'), /additionalProperties/);
console.log('TOOL-SCHEMA-OK ' + definitions.length + ' factory definitions; nested requiredness preserved');

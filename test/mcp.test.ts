import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleLine, TOOLS } from '../src/mcp.ts';

const T = 1_800_000_000;

function rpc(obj: object): any {
  const out = handleLine(JSON.stringify(obj), T);
  return out ? JSON.parse(out) : null;
}

test('initialize echoes the client protocol version rather than guessing', () => {
  const r = rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  assert.equal(r.result.protocolVersion, '2024-11-05');
  assert.equal(r.result.serverInfo.name, 'claude-session-guardian');
  assert.deepEqual(r.result.capabilities, { tools: {} });
  assert.equal(r.id, 1);
});

test('initialize without a version falls back to a known-good one', () => {
  const r = rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.match(r.result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/);
});

test('notifications get no reply, as the protocol requires', () => {
  assert.equal(rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(rpc({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }), null);
});

test('the tool surface is deliberately three tools', () => {
  const r = rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = r.result.tools.map((t: { name: string }) => t.name);
  // Every tool schema is resident context in every request, so this number is a design
  // constraint in a tool whose whole purpose is conserving budget.
  assert.equal(names.length, 3);
  assert.deepEqual(names, ['guardian_status', 'guardian_checkpoint', 'guardian_resume_context']);
});

test('every tool declares a usable schema and explains when to call it', () => {
  for (const t of TOOLS) {
    assert.ok(t.description.length > 80, `${t.name} description is too thin to guide a call`);
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.inputSchema.additionalProperties, false);
  }
});

test('an unknown method returns a JSON-RPC error, not a crash', () => {
  const r = rpc({ jsonrpc: '2.0', id: 3, method: 'no/such/method' });
  assert.equal(r.error.code, -32601);
  assert.match(r.error.message, /Method not found/);
});

test('tools/call validates its params', () => {
  const r = rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { arguments: {} } });
  assert.equal(r.error.code, -32602);
});

test('an unknown tool is an error result rather than a protocol error', () => {
  const r = rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /Unknown tool/);
});

test('malformed input is ignored rather than taking the server down', () => {
  assert.equal(handleLine('{not json', T), null);
  assert.equal(handleLine('', T), null);
  assert.equal(handleLine('[]', T)!.includes('error'), true);
});

test('ping is answered', () => {
  assert.deepEqual(rpc({ jsonrpc: '2.0', id: 6, method: 'ping' }).result, {});
});

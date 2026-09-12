// @vitest-environment jsdom
/**
 * The Connect-to-MCP dialog hands out config that has to be correct verbatim (D-313).
 *
 * WHAT THIS IS
 *   A DOM test over the seven client rows. It is not a snapshot: it asserts the
 *   specific keys each client requires, one assertion per client, because these
 *   strings are copy-pasted straight into a config file by a human and a wrong key
 *   fails silently in that client rather than here.
 *
 * WHY IT IS WORTH A TEST AT ALL
 *   Four of the seven differ from the obvious shape, and each was verified against
 *   that client's own docs (see the component's header and D-313): Windsurf takes
 *   `serverUrl` and not `url`, VS Code's root key is `servers` and not `mcpServers`,
 *   Zed's is `context_servers`, and Cline needs `"type": "streamableHttp"` in exactly
 *   that camelCase — the kebab spelling makes Cline fall back to SSE without saying
 *   so. Those are precisely the details a later "tidy up the duplication here" pass
 *   would flatten into one shared snippet, which is why they are pinned.
 */

import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { ConnectMcpDialog } from './ConnectMcpDialog';

/** A port that is deliberately NOT the default, so a hardcoded 19790 fails. */
const PORT = 24680;
const URL = `http://127.0.0.1:${PORT}/mcp`;

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) =>
    cmd === 'chroma_mcp_port'
      ? Promise.resolve(PORT)
      : Promise.resolve({ managed: true, healthy: true, stale: false }),
  );
});

afterEach(cleanup);

/**
 * Expand one client's row and return the text of the snippet inside it.
 *
 * Found by the toggle's accessible name rather than by walking parent nodes, so
 * restyling the row does not break every assertion below.
 */
async function snippetFor(label: RegExp): Promise<string> {
  const button = screen.getByRole('button', { name: label });
  const row = button.parentElement;
  if (!row) throw new Error(`no row around ${label}`);
  // The first row starts expanded; clicking it would collapse it.
  const alreadyOpen = within(row).queryByText((_, el) => el?.tagName === 'CODE');
  if (!alreadyOpen) fireEvent.click(button);
  const code = await within(row).findByText((_, el) => el?.tagName === 'CODE');
  return code.textContent ?? '';
}

describe('ConnectMcpDialog', () => {
  it('shows the live URL from the app rather than a hardcoded port', async () => {
    render(<ConnectMcpDialog open onOpenChange={() => {}} />);
    // The port comes from `chroma_mcp_port`, so a user who set CHROMA_MCP_PORT is
    // shown something they can actually paste.
    await waitFor(() => expect(screen.getAllByText(URL).length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByText('Running')).toBeTruthy());
  });

  it('never claims the server is down before it has looked', () => {
    // A dialog that flashes "Not running" on every open would train the user to
    // ignore the one line that matters when it IS down.
    invoke.mockImplementation(() => new Promise(() => {}));
    render(<ConnectMcpDialog open onOpenChange={() => {}} />);
    expect(screen.getByText('Checking…')).toBeTruthy();
  });

  it('degrades to the default port when the command is unavailable', async () => {
    // Not a Tauri context, or an older build without the command: the dialog must
    // still print a usable URL rather than `127.0.0.1:undefined`.
    invoke.mockRejectedValue(new Error('no such command'));
    render(<ConnectMcpDialog open onOpenChange={() => {}} />);
    await waitFor(() => expect(screen.getAllByText('http://127.0.0.1:19790/mcp').length).toBe(1));
  });

  it('gives Claude Code the --transport http form, not the stdio one', async () => {
    render(<ConnectMcpDialog open onOpenChange={() => {}} />);
    await waitFor(() => expect(screen.getAllByText(URL).length).toBeGreaterThan(0));
    const text = await snippetFor(/^Claude Code/);
    // Without `--transport http` the CLI reads the URL as a command to spawn.
    expect(text).toContain('claude mcp add --transport http apelles');
    expect(text).toContain(URL);
  });

  it.each([
    // client label, the keys that MUST be present, and what must NOT be
    ['Cursor', ['"mcpServers"', `"url": "${URL}"`], ['serverUrl', '"servers"']],
    ['Windsurf', ['"mcpServers"', `"serverUrl": "${URL}"`], ['"url"']],
    ['VS Code', ['"servers"', '"type": "http"', `"url": "${URL}"`], ['"mcpServers"']],
    ['Zed', ['"context_servers"', `"url": "${URL}"`], ['"mcpServers"']],
    ['Cline', ['"mcpServers"', '"type": "streamableHttp"', `"url": "${URL}"`], ['streamable-http']],
  ])('gives %s exactly its own documented shape', async (label, required, forbidden) => {
    render(<ConnectMcpDialog open onOpenChange={() => {}} />);
    await waitFor(() => expect(screen.getAllByText(URL).length).toBeGreaterThan(0));
    const text = await snippetFor(new RegExp(`^${(label as string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    for (const needle of required as string[]) expect(text).toContain(needle);
    for (const needle of forbidden as string[]) expect(text).not.toContain(needle);
  });

  it('keeps Claude Desktop on stdio, because its config file cannot take a URL', async () => {
    render(<ConnectMcpDialog open onOpenChange={() => {}} />);
    await waitFor(() => expect(screen.getAllByText(URL).length).toBeGreaterThan(0));
    const text = await snippetFor(/^Claude Desktop/);
    // A `url` field there does not merely fail — it corrupts the mcpServers
    // section on startup. This row must never grow one.
    expect(text).toContain('"command"');
    expect(text).toContain('apelles-mcp');
    expect(text).not.toContain('url');
  });
});

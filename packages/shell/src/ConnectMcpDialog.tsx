/**
 * @apelles/shell — the "Connect to MCP" help window.
 *
 * What it is: a shell-level, read-only help dialog (same trigger pattern as
 * `@apelles/keymap`'s `KeyboardShortcutsDialog` — one opener, next to it in
 * the chrome bar, shared by all three tabs) listing every MCP client
 * verified for this file (2026-09-12, real docs/config formats, not
 * guessed): Claude Code, Claude Desktop, Cursor, Windsurf, VS Code, Zed,
 * Cline. Each row is collapsed to a name + one line by default — the
 * command/config only shows once expanded — after the owner's own
 * reference point (Palmier Pro's "Connect an agent" settings page,
 * `scratch/` doesn't have a saved copy but the live screenshot showed the
 * shape directly): a short list of plain rows, not a wall of prose. Palmier
 * can offer a one-click "Install in Cursor ↗" deep link and a fixed local
 * HTTP port because it ships as a real installed app with a bundled server;
 * Apelles today is a dev checkout (stdio server, its own venv, no fixed
 * port, no distributed installer bundling `mcp/server.py` as a resource) —
 * so every row here is still a copy-this-command step, not a one-click
 * install. Closing that gap is real future work once Apelles itself ships
 * that way, not something this dialog can fake now.
 *
 * What it does NOT do (owner, live: "it should just give the command...
 * not actually connect"): it performs no setup and makes no connection
 * itself — it cannot start a venv, register an MCP server, or verify one is
 * running; those are real steps the human runs in their own client/
 * terminal/editor.
 *
 * Every command/snippet points at `mcp/run.sh`, not the venv's python
 * binary plus `server.py` as two separate things — the owner's own
 * reaction, live, to the two-path version: "why the data has env and all
 * ... it should just connect to our mcp server right once." The script
 * resolves its own location and execs the right interpreter itself, so
 * every client's config here is exactly one path, the venv is an
 * implementation detail none of them need to know about. JSON snippets use
 * `/ABS/PATH/TO/chroma` as an explicit, visibly-a-placeholder path rather
 * than `$(pwd)` (only the Claude Code CLI command gets real shell
 * expansion — a JSON config file has no shell to expand it).
 */

import { useState } from 'react';
import { CaretRightIcon, CheckIcon, CopyIcon, PlugsConnectedIcon } from '@phosphor-icons/react';
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle } from '@apelles/ui';

const VENV_SETUP = 'cd mcp\npython3 -m venv .venv\n.venv/bin/pip install -r requirements.txt';

const RUN_SCRIPT = '/ABS/PATH/TO/chroma/mcp/run.sh';

const MCP_SERVERS_SNIPPET = `{
  "mcpServers": {
    "apelles": {
      "command": "${RUN_SCRIPT}"
    }
  }
}`;

const VSCODE_SNIPPET = `{
  "servers": {
    "apelles": {
      "type": "stdio",
      "command": "${RUN_SCRIPT}"
    }
  }
}`;

const ZED_SNIPPET = `{
  "context_servers": {
    "apelles": {
      "source": "custom",
      "command": "${RUN_SCRIPT}"
    }
  }
}`;

interface ClientDef {
  id: string;
  label: string;
  /** One line, Palmier-style — not a paragraph. */
  hint: string;
  /** CLI command (Claude Code) instead of a JSON file. */
  cliCommand?: string;
  /** JSON config snippet, for every client that isn't CLI-based. */
  snippet?: string;
}

// Verified 2026-09-12 against each client's own current docs — see this
// file's module doc. Three of these seven genuinely differ in shape from
// the other four (VS Code's "servers" root key, Zed's "context_servers" +
// required "source": "custom"), so a single generic snippet would be wrong.
const CLIENTS: ClientDef[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    hint: 'Run once in Terminal, from the repo root, with Apelles running.',
    cliCommand: 'claude mcp add apelles -- "$(pwd)/mcp/.venv/bin/python" "$(pwd)/mcp/server.py"',
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    hint: 'Settings → Developer → Edit Config, then paste this in.',
    snippet: MCP_SERVERS_SNIPPET,
  },
  {
    id: 'cursor',
    label: 'Cursor',
    hint: 'Paste into .cursor/mcp.json (or ~/.cursor/mcp.json for every project).',
    snippet: MCP_SERVERS_SNIPPET,
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    hint: 'Paste into ~/.codeium/windsurf/mcp_config.json.',
    snippet: MCP_SERVERS_SNIPPET,
  },
  {
    id: 'vscode',
    label: 'VS Code',
    hint: 'Paste into .vscode/mcp.json — note the root key is "servers", not "mcpServers".',
    snippet: VSCODE_SNIPPET,
  },
  {
    id: 'zed',
    label: 'Zed',
    hint: 'Paste into ~/.config/zed/settings.json, under "context_servers".',
    snippet: ZED_SNIPPET,
  },
  {
    id: 'cline',
    label: 'Cline',
    hint: "Easiest via Cline's own panel: the MCP Servers icon → Configure tab.",
    snippet: MCP_SERVERS_SNIPPET,
  },
];

const WEBSITE_URL = 'https://apelles.studio';

function CopyButton({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access denied/unavailable — the command is still
      // selectable text, so this is a convenience failure, not a dead end.
    }
  };
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      onClick={copy}
      title={copied ? 'Copied' : 'Copy'}
      aria-label={copied ? 'Copied' : 'Copy'}
      className="absolute right-1.5 top-1.5 text-text-secondary hover:text-text-primary"
    >
      {copied ? <CheckIcon className="size-3.5 text-green-400" /> : <CopyIcon className="size-3.5" />}
    </Button>
  );
}

function ClientRow({ client, defaultOpen }: { client: ClientDef; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const command = client.cliCommand ?? client.snippet ?? '';

  return (
    <div className="border-t border-border-color first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 py-2.5 text-left"
      >
        <CaretRightIcon className={`size-3 shrink-0 text-text-secondary transition-transform ${open ? 'rotate-90' : ''}`} />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-text-primary">{client.label}</div>
          <div className="truncate text-[11px] text-text-secondary">{client.hint}</div>
        </div>
      </button>
      {open && (
        <div className="relative pb-3 pl-5">
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-border-color bg-bg-primary p-2.5 pr-9 text-[11px] leading-relaxed text-text-primary">
            <code>{command}</code>
          </pre>
          <CopyButton command={command} />
        </div>
      )}
    </div>
  );
}

export interface ConnectMcpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ConnectMcpDialog({ open, onOpenChange }: ConnectMcpDialogProps) {
  const [setupOpen, setSetupOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PlugsConnectedIcon className="size-4" />
            MCP
          </DialogTitle>
        </DialogHeader>

        <div>
          <button
            type="button"
            onClick={() => setSetupOpen((v) => !v)}
            className="flex w-full items-center gap-2 py-1 text-left"
          >
            <CaretRightIcon
              className={`size-3 shrink-0 text-text-secondary transition-transform ${setupOpen ? 'rotate-90' : ''}`}
            />
            <span className="text-[11px] text-text-secondary">
              First time? Set up the server's own dependencies once.
            </span>
          </button>
          {setupOpen && (
            <div className="relative pb-2 pl-5">
              <pre className="overflow-x-auto rounded-md border border-border-color bg-bg-primary p-2.5 pr-9 text-[11px] leading-relaxed text-text-primary">
                <code>{VENV_SETUP}</code>
              </pre>
              <CopyButton command={VENV_SETUP} />
            </div>
          )}
        </div>

        <div className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">Connect an agent</div>
        <div>
          {CLIENTS.map((c, i) => (
            <ClientRow key={c.id} client={c} defaultOpen={i === 0} />
          ))}
        </div>

        <div className="flex items-center justify-between border-t border-border-color pt-3">
          <a href={WEBSITE_URL} target="_blank" rel="noopener noreferrer" className="text-[11px] text-accent hover:underline">
            {WEBSITE_URL.replace('https://', '')}
          </a>
          <Button size="sm" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

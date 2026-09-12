/**
 * @apelles/shell — the "Connect to MCP" help window.
 *
 * What it is: a shell-level, read-only help dialog (same trigger pattern as
 * `@apelles/keymap`'s `KeyboardShortcutsDialog` — one opener, next to it in
 * the chrome bar, shared by all three tabs) listing every MCP client
 * verified for this file: Claude Code, Claude Desktop, Cursor, Windsurf,
 * VS Code, Zed, Cline. Each row is collapsed to a name + one line by
 * default — the command/config only shows once expanded — after the owner's
 * own reference point (Palmier Pro's "Connect an agent" settings page): a
 * short list of plain rows, not a wall of prose.
 *
 * **D-313 changed what these rows say.** Apelles now runs its own MCP server
 * (`apelles-mcp --http`, supervised from `lib.rs` `.setup()`) on a fixed
 * loopback port, so the primary answer for almost every client is a URL —
 * no checkout path, no venv, no subprocess for the client to manage. That is
 * the Palmier shape the owner asked for, and it is real now rather than
 * something this dialog has to fake.
 *
 * The URL is not hardcoded: the port comes from `chroma_mcp_port`, so a user
 * who set `CHROMA_MCP_PORT` is shown something they can actually paste. The
 * status line comes from `chroma_mcp_status` (the same supervisor snapshot
 * behind the Settings panel's sidecar cards), because "the URL doesn't work"
 * is the failure this dialog exists to catch, and the answer is usually
 * "the server isn't up yet."
 *
 * **Every client's HTTP shape here was verified against that client's own
 * current docs on 2026-09-12, not extrapolated from its stdio shape** — they
 * genuinely differ, and four of the seven would have been wrong by analogy:
 * Windsurf's field is `serverUrl` (not `url`), VS Code's root key is
 * `servers` (not `mcpServers`) and its `type` is required, Zed's root key is
 * `context_servers`, and Cline requires `"type": "streamableHttp"` in exactly
 * that camelCase — the kebab-case spelling other clients use makes Cline fall
 * back to SSE silently. See D-313 for the table and the sources.
 *
 * **Claude Desktop is the exception, and it is why the stdio path is still
 * here rather than deleted.** Its `claude_desktop_config.json` cannot express
 * a URL server at all — a `url` field corrupts the `mcpServers` section on
 * startup — and Anthropic's documented route for a remote server (the in-app
 * Custom Connectors UI) runs from Anthropic's cloud, so it cannot reach
 * `127.0.0.1`. That row therefore shows stdio, and the collapsible section at
 * the bottom keeps stdio available for everyone else too: for a client with
 * no HTTP support, and for anyone who would rather run the server themselves
 * (`CHROMA_MCP_NO_SPAWN`). `mcp/server.py` is still the documented rollback
 * (see `docs/notes/mcp-rust-port.md`), so it stays reachable there as well —
 * this dialog changes what is *recommended*, it does not retire anything.
 *
 * What it does NOT do (owner, live: "it should just give the command...
 * not actually connect"): it performs no setup and makes no connection
 * itself — it cannot register an MCP server in a client or verify one is
 * running there; those are real steps the human runs in their own client.
 * The one thing it does read is Apelles' own server status, which is a fact
 * about this app, not about the client.
 */

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { CaretRightIcon, CheckIcon, CopyIcon, PlugsConnectedIcon } from '@phosphor-icons/react';
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle } from '@apelles/ui';

/**
 * Mirrors `apelles_ai::sidecar::SidecarStatus` (the `camelCase` wire shape).
 * Only the fields this dialog actually renders are modelled.
 */
interface McpStatus {
  /** This app spawned and owns the server process. */
  managed: boolean;
  /** The last `/health` poll succeeded. */
  healthy: boolean;
  /** D-101: answering, but not the build this app would have started. */
  stale: boolean;
  lastError?: string;
}

/**
 * Kept in sync with `apelles_mcp::serve::DEFAULT_HTTP_PORT` and
 * `chroma::sidecar::MCP.default_port`, both of which pin it in a test. Only
 * used until `chroma_mcp_port` answers — so the dialog shows a sane URL for
 * the one frame before that resolves, rather than a flash of nothing.
 */
const DEFAULT_MCP_PORT = 19790;

/** How often to re-poll the server status while the dialog is open. */
const STATUS_POLL_MS = 2000;

const mcpUrl = (port: number) => `http://127.0.0.1:${port}/mcp`;

// --- stdio fallback -----------------------------------------------------
//
// Absolute placeholder paths rather than `$(pwd)`: a JSON config file has no
// shell to expand anything, and only the Claude Code CLI line gets real shell
// expansion.

const RUST_BINARY = '/ABS/PATH/TO/chroma/target/release/apelles-mcp';
const PYTHON_RUN_SCRIPT = '/ABS/PATH/TO/chroma/mcp/run.sh';

const STDIO_BUILD = 'cargo build --release -p apelles-mcp';

const STDIO_SNIPPET = `{
  "mcpServers": {
    "apelles": {
      "command": "${RUST_BINARY}"
    }
  }
}`;

const PYTHON_FALLBACK = `cd mcp
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
claude mcp add apelles -- ${PYTHON_RUN_SCRIPT}`;

// --- the clients --------------------------------------------------------

interface ClientDef {
  id: string;
  label: string;
  /** One line, Palmier-style — not a paragraph. */
  hint: string;
  /** The command or config to copy, given the resolved server URL. */
  config: (url: string) => string;
}

const CLIENTS: ClientDef[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    hint: 'Run once in Terminal. --transport http is required; without it the URL is read as a command.',
    config: (url) => `claude mcp add --transport http apelles ${url}`,
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop  ·  stdio only',
    hint: 'Its config file cannot take a URL — Settings → Developer → Edit Config, then paste this.',
    config: () => STDIO_SNIPPET,
  },
  {
    id: 'cursor',
    label: 'Cursor',
    hint: 'Paste into .cursor/mcp.json (or ~/.cursor/mcp.json for every project).',
    config: (url) => `{
  "mcpServers": {
    "apelles": {
      "url": "${url}"
    }
  }
}`,
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    hint: 'Paste into ~/.codeium/windsurf/mcp_config.json — the key is "serverUrl", not "url".',
    config: (url) => `{
  "mcpServers": {
    "apelles": {
      "serverUrl": "${url}"
    }
  }
}`,
  },
  {
    id: 'vscode',
    label: 'VS Code',
    hint: 'Paste into .vscode/mcp.json — root key is "servers", and "type" is required.',
    config: (url) => `{
  "servers": {
    "apelles": {
      "type": "http",
      "url": "${url}"
    }
  }
}`,
  },
  {
    id: 'zed',
    label: 'Zed',
    hint: 'Paste into settings.json (zed: open settings file), under "context_servers".',
    config: (url) => `{
  "context_servers": {
    "apelles": {
      "url": "${url}"
    }
  }
}`,
  },
  {
    id: 'cline',
    label: 'Cline',
    hint: 'MCP Servers icon → Configure. "streamableHttp" must be spelled exactly like this.',
    config: (url) => `{
  "mcpServers": {
    "apelles": {
      "type": "streamableHttp",
      "url": "${url}"
    }
  }
}`,
  },
];

const WEBSITE_URL = 'https://apelles.studio';

function CopyButton({ command, className }: { command: string; className?: string }) {
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
      className={className ?? 'absolute right-1.5 top-1.5 text-text-secondary hover:text-text-primary'}
    >
      {copied ? <CheckIcon className="size-3.5 text-green-400" /> : <CopyIcon className="size-3.5" />}
    </Button>
  );
}

function Snippet({ text }: { text: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-border-color bg-bg-primary p-2.5 pr-9 text-[11px] leading-relaxed text-text-primary">
        <code>{text}</code>
      </pre>
      <CopyButton command={text} />
    </div>
  );
}

function Disclosure({
  label,
  children,
  defaultOpen,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 py-1 text-left"
      >
        <CaretRightIcon
          className={`size-3 shrink-0 text-text-secondary transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className="text-[11px] text-text-secondary">{label}</span>
      </button>
      {open && <div className="pb-2 pl-5">{children}</div>}
    </div>
  );
}

function ClientRow({ client, url, defaultOpen }: { client: ClientDef; url: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);

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
        <div className="pb-3 pl-5">
          <Snippet text={client.config(url)} />
        </div>
      )}
    </div>
  );
}

/**
 * The live server state, in one line. `null` while the first poll is in
 * flight, so the dialog never claims "not running" before it has looked.
 */
function StatusLine({ status }: { status: McpStatus | null }) {
  if (status === null) {
    return <span className="text-text-secondary">Checking…</span>;
  }
  if (status.healthy && status.stale) {
    // D-101: answering, but not the build this app would have started —
    // almost always a server left over from an earlier `cargo build`.
    return (
      <span className="text-yellow-400">
        Running, but it&apos;s an older build — quit it and restart Apelles
      </span>
    );
  }
  if (status.healthy) {
    return (
      <span className="text-green-400">{status.managed ? 'Running' : 'Running (started outside Apelles)'}</span>
    );
  }
  return (
    <span className="text-yellow-400" title={status.lastError}>
      Not running — build it once with{' '}
      <code className="text-text-primary">cargo build -p apelles-mcp</code>
    </span>
  );
}

export interface ConnectMcpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ConnectMcpDialog({ open, onOpenChange }: ConnectMcpDialogProps) {
  const [port, setPort] = useState(DEFAULT_MCP_PORT);
  const [status, setStatus] = useState<McpStatus | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [p, s] = await Promise.all([
        invoke<number>('chroma_mcp_port'),
        invoke<McpStatus>('chroma_mcp_status'),
      ]);
      // Guarded rather than trusted: under a test harness (and in any build
      // where the command is missing) `invoke` resolves to undefined, and a
      // URL reading `http://127.0.0.1:undefined/mcp` would be worse than the
      // default.
      if (typeof p === 'number' && p > 0) setPort(p);
      if (s && typeof s.healthy === 'boolean') setStatus(s);
    } catch {
      // The command is unavailable (not a Tauri context, or an older build).
      // The URL below is still correct for the default port, so this degrades
      // to exactly the pre-D-313 behaviour rather than to a broken dialog.
    }
  }, []);

  // Only while open: this is a help dialog, not a monitor, and polling a
  // closed dialog would be a wakeup every 2s for nothing.
  useEffect(() => {
    if (!open) return;
    void refresh();
    const id = setInterval(() => void refresh(), STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [open, refresh]);

  const url = mcpUrl(port);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Both the unprefixed AND sm:-prefixed form, deliberately —
          `DialogContent`'s own default (`packages/ui/src/components/ui/
          dialog.tsx`) carries `sm:max-w-lg`, a sm:-VARIANT class;
          tailwind-merge only dedupes within the same variant, so an
          unprefixed override alone never touches it and 512px keeps winning
          past the sm breakpoint. Same fix, same reasoning, as
          `@apelles/keymap`'s `KeyboardShortcutsDialog` already documents. */}
      <DialogContent className="max-w-xl sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PlugsConnectedIcon className="size-4" />
            MCP
          </DialogTitle>
        </DialogHeader>

        <div className="rounded-md border border-border-color bg-bg-primary p-2.5">
          <div className="flex items-center justify-between gap-2">
            <code className="min-w-0 flex-1 truncate text-xs text-text-primary">{url}</code>
            <CopyButton command={url} className="shrink-0 text-text-secondary hover:text-text-primary" />
          </div>
          <div className="mt-1 text-[11px]">
            <StatusLine status={status} />
          </div>
        </div>

        <div className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">Connect an agent</div>
        <div>
          {CLIENTS.map((c, i) => (
            <ClientRow key={c.id} client={c} url={url} defaultOpen={i === 0} />
          ))}
        </div>

        <div className="border-t border-border-color pt-2">
          <Disclosure label="Rather run the server yourself? (stdio)">
            <div className="space-y-2">
              <p className="text-[11px] leading-relaxed text-text-secondary">
                Apelles starts one for you. To run it by hand instead, set{' '}
                <code className="text-text-primary">CHROMA_MCP_NO_SPAWN</code> so the app leaves the port alone,
                then point the client at the binary — no URL, the client spawns it.
              </p>
              <Snippet text={`${STDIO_BUILD}\nclaude mcp add apelles -- ${RUST_BINARY}`} />
              <p className="text-[11px] leading-relaxed text-text-secondary">
                The original Python server still works and is the documented rollback:
              </p>
              <Snippet text={PYTHON_FALLBACK} />
            </div>
          </Disclosure>
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

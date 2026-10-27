/**
 * High-Performance Native Bun Web Hub Server.
 *
 * Serves an interactive browser dashboard on localhost:8765 for multi-agent orchestration,
 * sidecar daemon monitoring, and speculative worktree battle inspection.
 */

import * as os from "node:os";
import type { Server, ServerWebSocket } from "bun";
import { AgentRegistry } from "../registry/agent-registry";
import { SidecarManager } from "../sidecars/sidecar-manager";
import type { HubConfig, HubEventMessage } from "./types";

export class WebHubServer {
	private server?: Server<unknown>;
	private clients = new Set<ServerWebSocket<unknown>>();
	private startedAt = Date.now();
	private config: HubConfig;

	constructor(config?: Partial<HubConfig>) {
		this.config = {
			port: config?.port ?? 8765,
			host: config?.host ?? "127.0.0.1",
			cwd: config?.cwd ?? process.cwd(),
		};
	}

	public async start(): Promise<{ port: number; url: string }> {
		const sidecarManager = SidecarManager.getInstance();
		await sidecarManager.discover(this.config.cwd);

		this.server = Bun.serve({
			port: this.config.port,
			hostname: this.config.host,
			fetch: async (req, server) => {
				const url = new URL(req.url);

				// WebSocket upgrade
				if (url.pathname === "/ws") {
					const success = server.upgrade(req, { data: { createdAt: Date.now() } });
					if (success) return undefined;
					return new Response("WebSocket upgrade failed", { status: 400 });
				}

				// API Endpoints
				if (url.pathname === "/api/health") {
					return Response.json({ status: "ok", timestamp: Date.now() });
				}

				if (url.pathname === "/api/status") {
					const agentList = AgentRegistry.global().list();
					const sidecarList = sidecarManager.list();
					return Response.json({
						status: "running",
						uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
						cwd: this.config.cwd,
						hostname: os.hostname(),
						port: this.config.port,
						agentsCount: agentList.length,
						sidecarsCount: sidecarList.length,
					});
				}

				if (url.pathname === "/api/agents") {
					const agents = AgentRegistry.global().list();
					return Response.json(agents);
				}

				if (url.pathname === "/api/sidecars") {
					const sidecars = sidecarManager.list();
					return Response.json(sidecars);
				}

				if (url.pathname.startsWith("/api/sidecars/") && url.pathname.endsWith("/start") && req.method === "POST") {
					const parts = url.pathname.split("/");
					const id = parts[3];
					try {
						const info = await sidecarManager.start(id);
						this.broadcast("sidecar_update", info);
						return Response.json({ success: true, sidecar: info });
					} catch (err: unknown) {
						return Response.json(
							{ success: false, error: err instanceof Error ? err.message : String(err) },
							{ status: 400 },
						);
					}
				}

				if (url.pathname.startsWith("/api/sidecars/") && url.pathname.endsWith("/stop") && req.method === "POST") {
					const parts = url.pathname.split("/");
					const id = parts[3];
					try {
						await sidecarManager.stop(id);
						const info = sidecarManager.getStatus(id);
						this.broadcast("sidecar_update", info);
						return Response.json({ success: true, sidecar: info });
					} catch (err: unknown) {
						return Response.json(
							{ success: false, error: err instanceof Error ? err.message : String(err) },
							{ status: 400 },
						);
					}
				}

				if (url.pathname.startsWith("/api/sidecars/") && url.pathname.endsWith("/logs")) {
					const parts = url.pathname.split("/");
					const id = parts[3];
					const logs = await sidecarManager.getLogs(id, 100);
					return new Response(logs, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
				}

				// Dashboard HTML
				if (url.pathname === "/" || url.pathname === "/index.html") {
					return new Response(this.renderDashboardHtml(), {
						headers: { "Content-Type": "text/html; charset=utf-8" },
					});
				}

				return new Response("Not Found", { status: 404 });
			},
			websocket: {
				open: ws => {
					this.clients.add(ws);
					ws.send(
						JSON.stringify({
							type: "connected",
							payload: { server: "aery-web-hub", version: "1.0.0" },
							timestamp: Date.now(),
						}),
					);
				},
				message: (_ws, message) => {
					try {
						const parsed = JSON.parse(String(message));
						if (parsed.type === "ping") {
							_ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
						}
					} catch {}
				},
				close: ws => {
					this.clients.delete(ws);
				},
			},
		});

		const actualPort = this.server.port ?? this.config.port;
		return {
			port: actualPort,
			url: `http://${this.config.host}:${actualPort}`,
		};
	}

	public broadcast(type: HubEventMessage["type"], payload: unknown): void {
		const message: HubEventMessage = {
			type,
			payload,
			timestamp: Date.now(),
		};
		const encoded = JSON.stringify(message);
		for (const client of this.clients) {
			try {
				client.send(encoded);
			} catch {}
		}
	}

	public async stop(): Promise<void> {
		for (const client of this.clients) {
			try {
				client.close();
			} catch {}
		}
		this.clients.clear();
		if (this.server) {
			this.server.stop(true);
			this.server = undefined;
		}
	}

	private renderDashboardHtml(): string {
		return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Aery Interactive Web Hub</title>
  <style>
    :root {
      --bg: #090a0f;
      --card-bg: #12151e;
      --border: #232936;
      --text: #e1e7ec;
      --text-muted: #8b949e;
      --accent: #58a6ff;
      --accent-glow: rgba(88, 166, 255, 0.15);
      --success: #3fb950;
      --warning: #d29922;
      --danger: #f85149;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    header {
      background: var(--card-bg);
      border-bottom: 1px solid var(--border);
      padding: 12px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .logo {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 700;
      font-size: 1.15rem;
      letter-spacing: -0.5px;
    }
    .logo-badge {
      background: linear-gradient(135deg, #1f6feb, #8957e5);
      color: white;
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .status-pill {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.8rem;
      background: rgba(63, 185, 80, 0.1);
      color: var(--success);
      padding: 4px 10px;
      border-radius: 20px;
      border: 1px solid rgba(63, 185, 80, 0.2);
    }
    .nav-tabs {
      display: flex;
      gap: 8px;
      padding: 12px 24px;
      background: rgba(18, 21, 30, 0.6);
      border-bottom: 1px solid var(--border);
    }
    .tab-btn {
      background: transparent;
      border: 1px solid transparent;
      color: var(--text-muted);
      padding: 6px 14px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.85rem;
      font-weight: 500;
      transition: all 0.15s ease;
    }
    .tab-btn:hover {
      color: var(--text);
      background: var(--border);
    }
    .tab-btn.active {
      color: var(--text);
      background: var(--card-bg);
      border-color: var(--border);
      box-shadow: 0 2px 4px rgba(0,0,0,0.2);
    }
    main {
      flex: 1;
      padding: 24px;
      overflow-y: auto;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 16px;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    }
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .card-title {
      font-weight: 600;
      font-size: 0.95rem;
    }
    .badge {
      font-size: 0.7rem;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 4px;
      text-transform: uppercase;
    }
    .badge-running { background: rgba(63, 185, 80, 0.2); color: var(--success); }
    .badge-stopped { background: rgba(139, 148, 158, 0.2); color: var(--text-muted); }
    .badge-crashed { background: rgba(248, 81, 73, 0.2); color: var(--danger); }
    .btn {
      background: #21262d;
      color: #c9d1d9;
      border: 1px solid var(--border);
      padding: 5px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.8rem;
    }
    .btn:hover { background: #30363d; color: white; }
    .btn-primary { background: #238636; color: white; border-color: #2ea043; }
    .btn-primary:hover { background: #2ea043; }
    .log-container {
      background: #050608;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.75rem;
      color: #8b949e;
      height: 240px;
      overflow-y: auto;
      white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <header>
    <div class="logo">
      <span>🦅 Aery Studio</span>
      <span class="logo-badge">WEB HUB</span>
    </div>
    <div style="display: flex; gap: 12px; align-items: center;">
      <span style="font-size: 0.8rem; color: var(--text-muted);" id="workspace-label">Loading...</span>
      <div class="status-pill">
        <span style="width: 7px; height: 7px; background: var(--success); border-radius: 50%;"></span>
        <span id="uptime-label">Active</span>
      </div>
    </div>
  </header>

  <div class="nav-tabs">
    <button class="tab-btn active" onclick="switchTab('agents')">🤖 Subagents (<span id="agents-count">0</span>)</button>
    <button class="tab-btn" onclick="switchTab('sidecars')">⚙️ Sidecar Daemons (<span id="sidecars-count">0</span>)</button>
    <button class="tab-btn" onclick="switchTab('system')">📊 System Health</button>
  </div>

  <main id="content-pane">
    <div id="tab-agents" class="grid"></div>
    <div id="tab-sidecars" class="grid" style="display: none;"></div>
    <div id="tab-system" style="display: none;"></div>
  </main>

  <script>
    let activeTab = 'agents';

    async function loadData() {
      try {
        const [statusRes, agentsRes, sidecarsRes] = await Promise.all([
          fetch('/api/status').then(r => r.json()),
          fetch('/api/agents').then(r => r.json()),
          fetch('/api/sidecars').then(r => r.json()),
        ]);

        document.getElementById('workspace-label').textContent = statusRes.cwd;
        document.getElementById('uptime-label').textContent = statusRes.uptimeSec + 's uptime';
        document.getElementById('agents-count').textContent = agentsRes.length;
        document.getElementById('sidecars-count').textContent = sidecarsRes.length;

        renderAgents(agentsRes);
        renderSidecars(sidecarsRes);
      } catch (err) {
        console.error('Failed to fetch hub state:', err);
      }
    }

    function renderAgents(agents) {
      const el = document.getElementById('tab-agents');
      if (agents.length === 0) {
        el.innerHTML = '<div style="color: var(--text-muted); font-size: 0.9rem; grid-column: 1/-1;">No subagents currently spawned in AgentRegistry.</div>';
        return;
      }
      el.innerHTML = agents.map(a => \`
        <div class="card">
          <div class="card-header">
            <span class="card-title">\${a.displayName || a.id}</span>
            <span class="badge badge-\${a.status}">\${a.status}</span>
          </div>
          <div style="font-size: 0.8rem; color: var(--text-muted);">
            <div><strong>Kind:</strong> \${a.kind}</div>
            <div><strong>ID:</strong> \${a.id}</div>
          </div>
        </div>
      \`).join('');
    }

    function renderSidecars(sidecars) {
      const el = document.getElementById('tab-sidecars');
      if (sidecars.length === 0) {
        el.innerHTML = '<div style="color: var(--text-muted); font-size: 0.9rem; grid-column: 1/-1;">No sidecars registered in ~/.aery/sidecars/ or .agents/sidecars/.</div>';
        return;
      }
      el.innerHTML = sidecars.map(s => \`
        <div class="card">
          <div class="card-header">
            <span class="card-title">\${s.name}</span>
            <span class="badge badge-\${s.status}">\${s.status}</span>
          </div>
          <div style="font-size: 0.8rem; color: var(--text-muted);">
            <div><strong>PID:</strong> \${s.pid || '-'}</div>
            <div><strong>Restarts:</strong> \${s.restartCount}</div>
            <div style="margin-top: 4px;"><code>\${s.config.command} \${(s.config.args || []).join(' ')}</code></div>
          </div>
          <div style="display: flex; gap: 8px; margin-top: 8px;">
            <button class="btn btn-primary" onclick="controlSidecar('\${s.id}', 'start')">Start</button>
            <button class="btn" onclick="controlSidecar('\${s.id}', 'stop')">Stop</button>
          </div>
        </div>
      \`).join('');
    }

    async function controlSidecar(id, action) {
      await fetch('/api/sidecars/' + id + '/' + action, { method: 'POST' });
      await loadData();
    }

    function switchTab(tab) {
      activeTab = tab;
      document.querySelectorAll('.tab-btn').forEach((b, i) => {
        b.classList.toggle('active', (i === 0 && tab === 'agents') || (i === 1 && tab === 'sidecars') || (i === 2 && tab === 'system'));
      });
      document.getElementById('tab-agents').style.display = tab === 'agents' ? 'grid' : 'none';
      document.getElementById('tab-sidecars').style.display = tab === 'sidecars' ? 'grid' : 'none';
      document.getElementById('tab-system').style.display = tab === 'system' ? 'block' : 'none';
    }

    // Connect WebSocket
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.onmessage = () => loadData();

    loadData();
    setInterval(loadData, 3000);
  </script>
</body>
</html>`;
	}
}

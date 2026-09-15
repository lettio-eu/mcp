# Lettio MCP

**Let your AI assistant read, search and send email from a private, EU-hosted mailbox.**

Lettio MCP is a [Model Context Protocol](https://modelcontextprotocol.io) server that connects
an AI agent (Claude, Cursor, and any other MCP client) to a [Lettio](https://lettio.eu)
mailbox over [JMAP](https://jmap.io). Your assistant can triage your inbox, find a message,
and send a reply — without your email ever leaving Europe.

- 🇪🇺 **European by default** — talks to your own EU-hosted mailbox, no third‑party middleman.
- 🔒 **Safe sending** — the server can only ever send *as the mailbox it is signed in to*. It
  cannot be tricked into sending from another address.
- 📬 **Everything an agent needs** — list, search, read and send, over the open JMAP standard.
- 👥 **One or many mailboxes** — configure a single account or several.

> Prefer nothing to install? Lettio also runs as a **hosted, OAuth‑secured** MCP server at
> `https://mcp.lettio.eu/mcp` — add that URL in your client and sign in. This npm package is the
> **local / self‑hosted** option for people who want to run it on their own machine.

## Tools

| Tool | What it does |
|------|--------------|
| `list_accounts` | List the mailboxes this server is configured for. |
| `list_mailboxes` | List folders in an account, with message and unread counts. |
| `list_recent_emails` | Most recent messages in a mailbox (defaults to the inbox). |
| `search_emails` | Free‑text search across sender, subject and body. |
| `read_email` | Full content of one message by id. |
| `send_email` | Send a plain‑text email **as the signed‑in mailbox**. |
| `reply_email` | Reply in‑thread (keeps the conversation), optionally reply‑all. |
| `set_read_status` | Mark a message read or unread. |
| `flag_email` | Flag (star) or unflag a message. |
| `move_email` | Move to a folder — `archive`, `trash` (reversible), or a folder name. |

## Requirements

- Node.js 18 or newer.
- A Lettio mailbox and an **app password** for it (use a dedicated app password, not your main login).

## Use with Claude Desktop

Add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "lettio": {
      "command": "npx",
      "args": ["-y", "@lettio/mcp"],
      "env": {
        "LETTIO_USERNAME": "you@yourcompany.eu",
        "LETTIO_PASSWORD": "your-app-password"
      }
    }
  }
}
```

Restart Claude Desktop; the Lettio tools appear in the tools menu.

## Configuration

Configured entirely through environment variables.

### Single mailbox

| Variable | Required | Description |
|----------|----------|-------------|
| `LETTIO_USERNAME` | yes | Full email address, e.g. `you@yourcompany.eu`. |
| `LETTIO_PASSWORD` | yes | Mailbox **app password**. |
| `LETTIO_HOST` | no | Mail host. Defaults to `https://mail.lettio.eu`. |
| `LETTIO_ACCOUNT_NAME` | no | Friendly name for the account (default: the username). |

### Several mailboxes

Set `LETTIO_ACCOUNTS` to a JSON array and omit the single‑account variables:

```json
[
  { "name": "work", "username": "you@yourcompany.eu", "password": "app-password" },
  { "name": "sales", "username": "sales@yourcompany.eu", "password": "app-password" }
]
```

Then pass `account: "work"` to any tool to choose which mailbox to use.

## Security

Sending is deliberately constrained. Before it sends, the server asks the mail host for the
identities the signed‑in mailbox is allowed to use and requires one that matches the login
address. The `From` header **and** the SMTP envelope `MAIL FROM` are both pinned to that
address. There is no parameter for choosing a different sender, so an agent can never send
"from" a foreign or arbitrary mailbox. Credentials are read from the environment, kept only in
memory, and never logged.

## Run from source

```bash
npm install
npm run build
LETTIO_USERNAME=you@yourcompany.eu LETTIO_PASSWORD=app-password npm start
```

## License

[MIT](./LICENSE) © Valmia Solutions s.r.o.

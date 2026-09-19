# perplexity-skill-for-openclaw

An **OpenClaw** skill for querying **Perplexity Pro** through Chrome DevTools Protocol
automation — grounded AI answers with citations, Deep Research, URL analysis, image
generation, conversation threads, and search over your own thread history (Library).

Verified end to end with OpenClaw only. Nothing else has been exercised against this
skill, so nothing else is claimed here.

It drives the **OpenClaw-managed Chrome** (CDP on `:18800`; `PERPLEXITY_CDP` overrides)
and reads the signed-in Perplexity session from that profile.

## Installation (OpenClaw)

```bash
git clone https://github.com/andychu666/perplexity-skill-for-openclaw ~/perplexity-skill-for-openclaw
mkdir -p ~/.openclaw/skills
ln -s ~/perplexity-skill-for-openclaw/perplexity-pro ~/.openclaw/skills/perplexity-pro
```

Then install the one runtime dependency (or reuse an existing `puppeteer-core` install —
the scripts auto-detect one):

```bash
cd ~/perplexity-skill-for-openclaw/perplexity-pro && npm install
```

## Requirements

- The **OpenClaw-managed Chrome** running with CDP on `:18800` (`PERPLEXITY_CDP` overrides)
- A **Perplexity Pro** account, signed in inside that browser profile
- **Node.js** and `puppeteer-core` (see above)

## Usage

See [perplexity-pro/SKILL.md](perplexity-pro/SKILL.md) for the flags, the session-only CLI,
JSON output shapes, and troubleshooting.

Quick checks:

```bash
node perplexity-pro/scripts/perplexity-session.mjs --whoami    # session: OK ... csrf: present
node perplexity-pro/scripts/perplexity-query.js "your question"
```

## License

MIT

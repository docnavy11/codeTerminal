# codeTerminal

## Infrastructure conventions

<!-- infra-pointer:start — managed block, safe to regenerate -->

This project is covered by the infrastructure documentation in
**[docnavy11/infra](https://github.com/docnavy11/infra)** (private). Read the
relevant page before changing how this project is built, deployed, exposed,
monitored or configured. On the dev server the checkout is at
`/home/dev/projects/infra`; on the laptop at `/Users/yvanveldeman/dev/infra`.

| Question | Document |
|---|---|
| How does deployment work here? | `README.md` — the `deploy.sh` + `infra/` + `dist/` convention |
| How do I deploy, debug a 502, or restore? | `runbooks.md` |
| Which domain does this serve, and from where? | `services.md` |
| What is monitored, and how do alerts reach me? | `monitoring.md` |
| What is this project's state and known traps? | `projects/codeTerminal.md` |
| Where does everything live? | `architecture.md` |
| What is backed up, and how do I restore it? | `backups.md` |
| Known security gaps, and where secrets live | `security.md` |
| What is still outstanding? | `TODO.md` |
| What is actually running right now? | `generated/` — machine-collected, never hand-edited |

### Rules

- **Deploy only with `./deploy.sh`, from the dev server.** Never edit files
  directly on prod — the next deploy runs `rsync --delete` and silently
  overwrites them.
- **Never commit secrets.** Real `.env` files stay on the server at mode 600;
  commit an `env.example` documenting the required keys instead.
- **Never pin a Traefik route to a container IP or a full container name.** Both
  change on redeploy. Use a container name for `/opt` stacks, or a
  `service: http-0-<app-uuid>@docker` reference for Coolify apps. See
  `runbooks.md`.
- **A new public hostname is not finished until it is monitored.**
  `urleditor.online` answered 503 for three weeks with 32,876 failed healthchecks
  because nothing watched it. Add it to uptime-kuma (`monitoring.md`).
- **Directory names are not reliable.** `intools-ai` serves
  `beteretools.linkflow.be`; `AI-readiness` serves `ai-eu-readiness.linkflow.be`;
  `scraper` is the Video Knowledge Base. Confirm via `deploy.sh`, not the name.

### Keeping the docs true is part of the change, not a follow-up

A change is finished when the documentation describes it. In the **same session**
that you change how this project is built, deployed, exposed, backed up or
monitored, update the infra page that covers it, re-run `collect-facts.sh` if
what is running changed, and commit and push the infra repo.

### If reality does not match these docs, report it

Drift is a defect, not an inconvenience — an undocumented deviation is how a
route silently 502s for weeks, or how a token ends up in a world-readable file.

1. **Do not silently work around it.**
2. State plainly what you found and what the docs claim.
3. If the docs are wrong, fix them in the infra repo.
4. If neither is right, add it to `infra/TODO.md` rather than leaving it
   undocumented.

Check this project against the documented conventions:

```bash
/home/dev/projects/infra/check-project.sh
```

It validates version control, unpushed work, tracked secrets, the deploy
convention, and whether the live domain actually responds. Exit 0 means no
failures.

<!-- infra-pointer:end -->
# openfda-mcp-server - Directory Structure

Generated on: 2026-08-07 09:31:48

```text
openfda-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   ├── 0.2.x/
│   ├── 0.3.x/
│   ├── 0.4.x/
│   ├── 0.5.x/
│   ├── 0.6.x/
│   ├── 0.7.x/
│   └── template.md
├── claude-plans/
├── docs/
│   └── design.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── openfda-mirror.ts
│   ├── release-github.ts
│   ├── split-changelog.ts
│   └── tree.ts
├── skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   └── tools/
│   │       ├── definitions/
│   │       │   ├── count-values.tool.ts
│   │       │   ├── dataframe-describe.tool.ts
│   │       │   ├── dataframe-query.tool.ts
│   │       │   ├── describe-fields.tool.ts
│   │       │   ├── drug-profile.tool.ts
│   │       │   ├── get-drug-label.tool.ts
│   │       │   ├── index.ts
│   │       │   ├── lookup-ndc.tool.ts
│   │       │   ├── search-adverse-events.tool.ts
│   │       │   ├── search-animal-events.tool.ts
│   │       │   ├── search-device-clearances.tool.ts
│   │       │   ├── search-drug-approvals.tool.ts
│   │       │   ├── search-drug-shortages.tool.ts
│   │       │   ├── search-recalls.tool.ts
│   │       │   └── search-tobacco-reports.tool.ts
│   │       ├── field-catalog.ts
│   │       ├── format-utils.ts
│   │       └── schema-utils.ts
│   ├── services/
│   │   ├── canvas/
│   │   │   └── canvas-accessor.ts
│   │   └── openfda/
│   │       ├── mirror/
│   │       │   ├── bulk-stream.ts
│   │       │   ├── datasets.ts
│   │       │   ├── harvester.ts
│   │       │   ├── index.ts
│   │       │   ├── mirror-registry.ts
│   │       │   ├── query.ts
│   │       │   └── refresh-schedule.ts
│   │       ├── canvas-spill.ts
│   │       ├── openfda-service.ts
│   │       ├── page-budget.ts
│   │       └── types.ts
│   └── index.ts
├── tests/
│   ├── config/
│   │   └── server-config.test.ts
│   ├── mcp-server/
│   │   └── tools/
│   │       ├── definitions/
│   │       │   ├── canvas-staging-parity.test.ts
│   │       │   ├── count-values.tool.test.ts
│   │       │   ├── dataframe-describe.tool.test.ts
│   │       │   ├── dataframe-query.tool.test.ts
│   │       │   ├── describe-fields.tool.test.ts
│   │       │   ├── drug-profile.tool.test.ts
│   │       │   ├── get-drug-label.tool.test.ts
│   │       │   ├── input-validation.test.ts
│   │       │   ├── lookup-ndc.tool.test.ts
│   │       │   ├── page-budget-contract.test.ts
│   │       │   ├── pagination-contract.test.ts
│   │       │   ├── record-parity.test.ts
│   │       │   ├── search-adverse-events-edge.test.ts
│   │       │   ├── search-adverse-events.tool.test.ts
│   │       │   ├── search-animal-events.tool.test.ts
│   │       │   ├── search-device-clearances.tool.test.ts
│   │       │   ├── search-drug-approvals.tool.test.ts
│   │       │   ├── search-drug-shortages.tool.test.ts
│   │       │   ├── search-recalls-canvas.test.ts
│   │       │   ├── search-recalls.tool.test.ts
│   │       │   ├── search-tobacco-reports.tool.test.ts
│   │       │   └── tools-edge-cases.test.ts
│   │       └── format-utils.test.ts
│   └── services/
│       └── openfda/
│           ├── mirror/
│           │   ├── bulk-stream.test.ts
│           │   ├── datasets.test.ts
│           │   ├── harvester.test.ts
│           │   ├── mirror-fixture.ts
│           │   ├── query.test.ts
│           │   ├── refresh-schedule.test.ts
│           │   └── routing.test.ts
│           ├── canvas-spill.test.ts
│           ├── openfda-service-security.test.ts
│           └── openfda-service.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CITATION.cff
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._

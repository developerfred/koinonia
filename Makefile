# Koinonia QA entry points. `make qa` runs every gate and prints PASS / FAIL / SKIP(reason) per gate.
# Components still being written are SKIPPED with a reason, never silently ignored. See qa/README.md.
SHELL := /bin/sh
GATES := node qa/tools/gates.mjs

.PHONY: qa qa-fast qa-strict qa-list install fixtures daemon-build test-daemon test-studio test-tokens contract integration e2e fuzz fuzz-zig soak soak-full evals evals-update security secrets audit site lint qa-selfcheck clean-qa

qa:            ## everything (local)
	@$(GATES)
qa-fast:       ## skip slow gates (e2e, soak, site, audit, release build)
	@$(GATES) --fast
qa-strict:     ## CI mode: any skipped gate is a failure
	@QA_STRICT=1 $(GATES)
qa-list:
	@$(GATES) --list

install:       ## qa deps + Playwright Chromium
	cd qa && npm ci --no-audit --no-fund && npx playwright install chromium
fixtures:      ## regenerate golden fixtures (qa/fixtures)
	node qa/tools/gen-fixtures.mjs
daemon-build:  ## build koinonia-d into qa/.out/daemon (does not touch daemon/zig-out)
	@$(GATES) --only daemon:build

test-daemon:   ; @$(GATES) --only daemon:fmt,daemon:test,qa:zig-conformance+fuzz
test-studio:   ; @$(GATES) --only studio:typecheck,studio:test,studio:build
test-tokens:   ; @$(GATES) --only tokens:typecheck,tokens:test
lint:          ; @$(GATES) --only lint:ts
contract:      ; @$(GATES) --only contract
integration:   ; @$(GATES) --only daemon:build,integration
e2e:           ; @$(GATES) --only e2e:playwright
fuzz:          ; @$(GATES) --only qa:zig-conformance+fuzz,fuzz,properties
fuzz-zig:      ## coverage-guided fuzzing of the Zig parsers (runs until Ctrl-C)
	cd qa/zig && zig build test --fuzz
soak:          ; @$(GATES) --only daemon:build,soak:smoke
soak-full:     ## 10 minute soak
	@$(GATES) --only daemon:build >/dev/null; cd qa && npx tsx soak/soak.ts --profile full
evals:         ; @$(GATES) --only evals:token-economy
evals-update:  ## accept new token-economy numbers (review the baseline.json diff!)
	cd qa && npm run -s evals:update
security:      ; @$(GATES) --group security
secrets:       ; @$(GATES) --only security:secrets
audit:         ; @$(GATES) --only security:audit
site:          ; @$(GATES) --group site
qa-selfcheck:  ## validate the harness itself against the Node reference daemon (no Zig needed)
	cd qa && KOINONIA_D_BIN=$(CURDIR)/qa/tools/ref-daemon npx vitest run integration security fuzz/daemon && KOINONIA_D_BIN=$(CURDIR)/qa/tools/ref-daemon npx tsx soak/soak.ts --profile smoke
clean-qa:
	rm -rf qa/.out qa/test-results qa/playwright-report qa/zig/.zig-cache

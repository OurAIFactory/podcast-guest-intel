@echo off
cd /d "%~dp0"
call npm install --package-lock-only --no-audit --no-fund
git init -b main
git add -A
git -c core.autocrlf=false -c user.email=ops@theknowledgeformula.com -c user.name="PODManager.ai" commit -m "Initial: containerized podcast-guest-intel web/API (durability-compliant)"
echo ===LOG===
git log --oneline -1
echo ===FILES===
git ls-files

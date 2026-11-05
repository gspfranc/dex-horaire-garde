#!/usr/bin/env sh
# Lance DEX en local (Linux / macOS).
#   ./start.sh                 -> mot de passe "dex", port 5000
#   EDIT_PASSWORD=secret PORT=8000 ./start.sh
set -e
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "Creation de l'environnement virtuel..."
  python3 -m venv .venv
  ./.venv/bin/python -m pip install --quiet --upgrade pip
  ./.venv/bin/python -m pip install --quiet -r requirements.txt
fi

export EDIT_PASSWORD="${EDIT_PASSWORD:-dex}"
export PORT="${PORT:-5000}"
export SECRET_KEY="${SECRET_KEY:-$(./.venv/bin/python -c 'import secrets; print(secrets.token_hex(32))')}"

echo ""
echo "  DEX demarre sur http://127.0.0.1:$PORT"
echo "  Mot de passe d'edition : $EDIT_PASSWORD"
echo ""
exec ./.venv/bin/python app.py

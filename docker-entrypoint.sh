#!/bin/sh
# Point d'entree du conteneur DEX.
#
# Le dossier de donnees est un dossier de l'hote monte dans le conteneur : il
# appartient donc a l'utilisateur de l'hote, pas a l'utilisateur applicatif.
# Sans ajustement, l'application ne peut pas y ecrire sa base.
#
# Demarche : on commence en root, on aligne le proprietaire du dossier monte,
# puis on abandonne les privileges pour lancer l'application sous un compte non
# privilegie. Si l'abandon de privileges est impossible (systeme de fichiers de
# l'hote qui ignore chown, par exemple un partage Windows ou un montage reseau),
# on continue en root plutot que de refuser de demarrer : un calendrier qui
# fonctionne vaut mieux qu'un conteneur mort.

set -e

DATA="${DEX_DATA_DIR:-/data}"
APP_UID="${DEX_UID:-10001}"
APP_GID="${DEX_GID:-10001}"

mkdir -p "$DATA" 2>/dev/null || true

if [ "$(id -u)" = "0" ]; then
  chown -R "$APP_UID:$APP_GID" "$DATA" 2>/dev/null || true

  # setpriv remplace le processus courant : les signaux (SIGTERM a l'arret du
  # conteneur) arrivent donc directement a gunicorn, contrairement a « su ».
  if command -v setpriv >/dev/null 2>&1 && setpriv \
        --reuid="$APP_UID" --regid="$APP_GID" --init-groups \
        sh -c "touch '$DATA/.dex-entry-test' && rm -f '$DATA/.dex-entry-test'" \
        >/dev/null 2>&1; then
    echo "DEX: donnees dans $DATA, application lancee sous l'uid $APP_UID." >&2
    exec setpriv --reuid="$APP_UID" --regid="$APP_GID" --init-groups "$@"
  fi

  echo "DEX: $DATA n'est pas accessible en ecriture pour l'uid $APP_UID" >&2
  echo "DEX: (systeme de fichiers de l'hote qui ignore chown ?)." >&2
  echo "DEX: demarrage en root pour que le montage reste utilisable." >&2
fi

exec "$@"

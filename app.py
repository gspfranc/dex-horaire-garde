"""
DEX — Gestionnaire d'horaire de garde partagee.

Application Flask permettant de "tagger" chaque jour du calendrier a Oli ou Phil,
d'y ajouter une note libre, et de calculer automatiquement le nombre de jours
de garde de chacun. Lecture seule par defaut; edition apres authentification.
"""

from __future__ import annotations

import io
import os
import secrets
import sqlite3
import tempfile
from calendar import monthrange
from datetime import date, datetime, timedelta
from functools import wraps

from flask import (
    Flask,
    flash,
    jsonify,
    redirect,
    render_template,
    request,
    send_file,
    session,
    url_for,
)
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import check_password_hash, generate_password_hash

db = SQLAlchemy()

# --------------------------------------------------------------------------- #
#  Configuration des gardiens
# --------------------------------------------------------------------------- #

PEOPLE = {
    "Oli": {"label": "Oli", "color": "#2dd4bf"},
    "Phil": {"label": "Phil", "color": "#fbbf24"},
}

MONTH_NAMES = [
    "Janvier", "Février", "Mars", "Avril", "Mai", "Juin",
    "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre",
]
MONTH_ABBR = [
    "Janv.", "Févr.", "Mars", "Avr.", "Mai", "Juin",
    "Juil.", "Août", "Sept.", "Oct.", "Nov.", "Déc.",
]
# Les semaines commencent le dimanche.
# WEEK_START est l'indice Python du jour place en premiere colonne
# (lundi = 0, ... samedi = 5, dimanche = 6).
WEEK_START = 6

_DAY_ABBR_LUNDI = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"]
DAY_ABBR = [_DAY_ABBR_LUNDI[(WEEK_START + i) % 7] for i in range(7)]

# Colonnes tombant sur un samedi ou un dimanche, pour la mise en evidence.
WEEKEND_COLUMNS = tuple(i for i in range(7) if (WEEK_START + i) % 7 >= 5)

NOTE_PRESETS = ["Vacances", "École", "Vétérinaire", "Toilettage", "Voyage", "Garderie"]

# Phrase a saisir pour confirmer la remise a zero de la base.
RESET_PHRASE = "REINITIALISER"

# Taille maximale d'un fichier de base importe.
MAX_IMPORT_BYTES = 16 * 1024 * 1024


def read_entries_from_sqlite(path: str) -> list[dict]:
    """Lit les journees d'un fichier SQLite fourni par l'utilisateur.

    Le fichier est traite comme une donnee non fiable : on verifie qu'il s'agit
    bien d'une base SQLite saine contenant une table « day_entries » exploitable,
    et chaque valeur est revalidee avant d'etre reinjectee. Leve ValueError avec
    un message affichable si le fichier ne convient pas.
    """
    try:
        con = sqlite3.connect("file:%s?mode=ro" % path.replace("?", "%3f"), uri=True)
    except sqlite3.Error:
        raise ValueError("Fichier illisible.")

    try:
        try:
            if con.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("La base est corrompue.")
            tables = {
                row[0]
                for row in con.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                )
            }
        except sqlite3.DatabaseError:
            raise ValueError(
                "Ce fichier n'est pas une base SQLite. Importez le fichier "
                "obtenu par « Exporter »."
            )

        if "day_entries" not in tables:
            raise ValueError(
                "Aucune table « day_entries » : ce n'est pas une base DEX."
            )

        columns = {row[1] for row in con.execute("PRAGMA table_info(day_entries)")}
        missing = {"day", "owner", "note"} - columns
        if missing:
            raise ValueError(
                "Colonnes absentes de « day_entries » : %s." % ", ".join(sorted(missing))
            )

        found = {}
        for raw_day, raw_owner, raw_note in con.execute(
            "SELECT day, owner, note FROM day_entries"
        ):
            if isinstance(raw_day, bytes):
                raw_day = raw_day.decode("utf-8", "replace")
            if isinstance(raw_day, date):
                day = raw_day
            else:
                try:
                    day = datetime.strptime(str(raw_day).strip()[:10], "%Y-%m-%d").date()
                except (ValueError, TypeError):
                    continue  # ligne inutilisable : on l'ignore

            owner = raw_owner if raw_owner in PEOPLE else None
            note = (str(raw_note).strip()[:500] or None) if raw_note else None
            if owner is None and note is None:
                continue
            found[day] = {"day": day, "owner": owner, "note": note}

        if not found:
            raise ValueError("Ce fichier ne contient aucune journée exploitable.")
        return list(found.values())
    finally:
        con.close()


# --------------------------------------------------------------------------- #
#  Modele
# --------------------------------------------------------------------------- #

class DayEntry(db.Model):
    """Une journee du calendrier : a qui elle appartient + note libre."""

    __tablename__ = "day_entries"

    id = db.Column(db.Integer, primary_key=True)
    day = db.Column(db.Date, unique=True, nullable=False, index=True)
    owner = db.Column(db.String(32), nullable=True)
    note = db.Column(db.Text, nullable=True)
    updated_at = db.Column(
        db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    def to_dict(self) -> dict:
        return {
            "date": self.day.isoformat(),
            "owner": self.owner,
            "note": self.note or "",
        }

    @property
    def is_empty(self) -> bool:
        return not self.owner and not (self.note or "").strip()


# --------------------------------------------------------------------------- #
#  Authentification
# --------------------------------------------------------------------------- #

def is_editor() -> bool:
    return bool(session.get("editor"))


def editor_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        if not is_editor():
            if request.path.startswith("/api/"):
                return jsonify(error="Authentification requise pour modifier."), 401
            return redirect(url_for("login", next=request.path))
        return view(*args, **kwargs)

    return wrapper


# --------------------------------------------------------------------------- #
#  Helpers calendrier / statistiques
# --------------------------------------------------------------------------- #

def month_bounds(year: int, month: int) -> tuple[date, date]:
    return date(year, month, 1), date(year, month, monthrange(year, month)[1])


def week_offset(day: date) -> int:
    """Rang de la journee dans sa semaine (0 = premiere colonne, le dimanche)."""
    return (day.weekday() - WEEK_START) % 7


def month_grid(year: int, month: int) -> list[list[date]]:
    """Grille de semaines completes (dimanche -> samedi) couvrant le mois."""
    first, last = month_bounds(year, month)
    cursor = first - timedelta(days=week_offset(first))
    end = last + timedelta(days=6 - week_offset(last))
    weeks: list[list[date]] = []
    current: list[date] = []
    while cursor <= end:
        current.append(cursor)
        if len(current) == 7:
            weeks.append(current)
            current = []
        cursor += timedelta(days=1)
    return weeks


def count_days(start: date | None = None, end: date | None = None) -> dict:
    """Nombre de jours tagges par personne sur un intervalle."""
    query = db.session.query(DayEntry.owner, db.func.count(DayEntry.id)).filter(
        DayEntry.owner.isnot(None)
    )
    if start is not None:
        query = query.filter(DayEntry.day >= start)
    if end is not None:
        query = query.filter(DayEntry.day <= end)

    counts = {name: 0 for name in PEOPLE}
    for owner, total in query.group_by(DayEntry.owner).all():
        if owner in counts:
            counts[owner] = total
    return counts


def scope_block(counts: dict, total_days: int | None = None) -> dict:
    """Bloc de statistiques pret a afficher pour une periode."""
    tagged = sum(counts.values())
    oli, phil = counts.get("Oli", 0), counts.get("Phil", 0)
    block = {
        "counts": counts,
        "tagged": tagged,
        "shares": {
            name: round(counts[name] / tagged * 100) if tagged else 0
            for name in PEOPLE
        },
        "gap": abs(oli - phil),
        "leader": "Oli" if oli > phil else ("Phil" if phil > oli else None),
    }
    if total_days is not None:
        block["total_days"] = total_days
        block["untagged"] = max(total_days - tagged, 0)
    return block


def build_stats(year: int) -> dict:
    """Bilan de l'annee : les totaux sont annuels, jamais mensuels."""
    jan1, dec31 = date(year, 1, 1), date(year, 12, 31)
    return scope_block(count_days(jan1, dec31), (dec31 - jan1).days + 1)


def entries_between(start: date, end: date) -> dict:
    rows = (
        DayEntry.query.filter(DayEntry.day >= start, DayEntry.day <= end)
        .order_by(DayEntry.day)
        .all()
    )
    return {row.day.isoformat(): row.to_dict() for row in rows}


def parse_iso(value: str) -> date:
    return datetime.strptime(value.strip(), "%Y-%m-%d").date()


def shift_month(year: int, month: int, delta: int) -> tuple[int, int]:
    index = (year * 12 + (month - 1)) + delta
    return index // 12, index % 12 + 1


# --------------------------------------------------------------------------- #
#  Fabrique d'application
# --------------------------------------------------------------------------- #

def create_app() -> Flask:
    app = Flask(__name__)

    data_dir = os.environ.get("DEX_DATA_DIR", os.path.join(app.root_path, "data"))

    # Le dossier de donnees est cree au premier demarrage, puis verifie en
    # ecriture : avec un dossier de l'hote monte dans un conteneur, les droits
    # peuvent manquer, et l'erreur SQLAlchemy qui en decoule n'explique rien.
    try:
        os.makedirs(data_dir, exist_ok=True)
        probe = os.path.join(data_dir, ".dex-write-test")
        with open(probe, "w", encoding="utf-8") as fh:
            fh.write("ok")
        os.unlink(probe)
    except OSError as exc:
        raise RuntimeError(
            "Le dossier de données « %s » n'est pas accessible en écriture "
            "(%s). En Docker avec un dossier de l'hôte monté, donnez les droits "
            "d'écriture à l'utilisateur du conteneur (uid 10001) — par exemple "
            "« chown -R 10001:10001 data » sur un hôte Linux — ou repassez à un "
            "volume Docker nommé avec DEX_DATA_PATH=dex-data." % (data_dir, exc)
        ) from exc

    app.config.update(
        SECRET_KEY=os.environ.get("SECRET_KEY") or secrets.token_hex(32),
        SQLALCHEMY_DATABASE_URI=os.environ.get(
            "DATABASE_URL", "sqlite:///" + os.path.join(data_dir, "dex.sqlite3")
        ),
        SQLALCHEMY_TRACK_MODIFICATIONS=False,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        PERMANENT_SESSION_LIFETIME=timedelta(days=30),
        JSON_SORT_KEYS=False,
        MAX_CONTENT_LENGTH=MAX_IMPORT_BYTES,
    )

    # Mot de passe d'edition : hash si fourni, sinon mot de passe en clair.
    password_hash = os.environ.get("EDIT_PASSWORD_HASH")
    if not password_hash:
        password_hash = generate_password_hash(os.environ.get("EDIT_PASSWORD", "dex"))
    app.config["EDIT_PASSWORD_HASH"] = password_hash

    db.init_app(app)
    with app.app_context():
        db.create_all()

    # ----------------------------- contexte -------------------------------- #

    @app.template_global()
    def static_url(filename: str) -> str:
        """URL d'un fichier statique horodatee par sa date de modification.

        Evite qu'un navigateur ou un cache intermediaire continue de servir un
        ancien CSS/JS apres une mise a jour : le lien change avec le fichier.
        """
        try:
            stamp = int(os.path.getmtime(os.path.join(app.static_folder, filename)))
        except OSError:
            stamp = 0
        return url_for("static", filename=filename, v=stamp)

    @app.context_processor
    def inject_globals():
        today = date.today()
        return {
            "people": PEOPLE,
            "can_edit": is_editor(),
            "month_names": MONTH_NAMES,
            "month_abbr": MONTH_ABBR,
            "day_abbr": DAY_ABBR,
            "weekend_columns": WEEKEND_COLUMNS,
            "note_presets": NOTE_PRESETS,
            "reset_phrase": RESET_PHRASE,
            "max_import_bytes": MAX_IMPORT_BYTES,
            "today_iso": today.isoformat(),
            "today_year": today.year,
            "today_month": today.month,
        }

    # ------------------------------- vues ---------------------------------- #

    @app.route("/")
    def home():
        today = date.today()
        return redirect(url_for("month_view", year=today.year, month=today.month))

    @app.route("/mois/<int:year>/<int:month>")
    def month_view(year: int, month: int):
        if not 1 <= month <= 12 or not 1970 <= year <= 2200:
            today = date.today()
            return redirect(url_for("month_view", year=today.year, month=today.month))

        weeks = month_grid(year, month)
        entries = entries_between(weeks[0][0], weeks[-1][-1])
        prev_y, prev_m = shift_month(year, month, -1)
        next_y, next_m = shift_month(year, month, 1)

        return render_template(
            "month.html",
            year=year,
            month=month,
            weeks=weeks,
            entries=entries,
            stats=build_stats(year),
            prev=(prev_y, prev_m),
            next=(next_y, next_m),
            month_label="%s %s" % (MONTH_NAMES[month - 1], year),
        )

    @app.route("/annee/<int:year>")
    def year_view(year: int):
        if not 1970 <= year <= 2200:
            return redirect(url_for("year_view", year=date.today().year))

        months = []
        for m in range(1, 13):
            first, last = month_bounds(year, m)
            counts = count_days(first, last)
            months.append(
                {
                    "month": m,
                    "label": MONTH_NAMES[m - 1],
                    "weeks": month_grid(year, m),
                    "entries": entries_between(first, last),
                    "counts": counts,
                    "tagged": sum(counts.values()),
                    "days": (last - first).days + 1,
                }
            )

        return render_template(
            "year.html",
            year=year,
            months=months,
            summary=build_stats(year),
        )

    @app.route("/login", methods=["GET", "POST"])
    def login():
        target = request.values.get("next") or url_for("home")
        if not target.startswith("/"):
            target = url_for("home")
        if is_editor():
            return redirect(target)

        if request.method == "POST":
            if check_password_hash(
                app.config["EDIT_PASSWORD_HASH"], request.form.get("password", "")
            ):
                session["editor"] = True
                session.permanent = True
                flash("Mode édition activé — bonne promenade !", "success")
                return redirect(target)
            flash("Mot de passe incorrect.", "error")

        return render_template("login.html", next_url=target)

    @app.post("/logout")
    def logout():
        session.pop("editor", None)
        flash("Retour en lecture seule.", "success")
        return redirect(request.referrer or url_for("home"))

    # -------------------------------- API ---------------------------------- #

    @app.get("/api/entries")
    def api_entries():
        try:
            start = parse_iso(request.args["start"])
            end = parse_iso(request.args["end"])
        except (KeyError, ValueError):
            return jsonify(error="Paramètres start et end (AAAA-MM-JJ) requis."), 400
        return jsonify(entries=entries_between(start, end))

    @app.get("/api/stats")
    def api_stats():
        try:
            year = int(request.args.get("year", date.today().year))
        except ValueError:
            return jsonify(error="Année invalide."), 400
        if not 1970 <= year <= 2200:
            return jsonify(error="Année hors limites."), 400
        return jsonify(stats=build_stats(year))

    def _stats_year(payload, fallback: date) -> int:
        """Annee du bilan a renvoyer : celle affichee par le client si elle est
        fournie, sinon celle de la premiere date touchee. Sans cela, peindre
        une plage a cheval sur deux annees renvoie le bilan de la mauvaise."""
        try:
            year = int(payload.get("year"))
        except (TypeError, ValueError):
            return fallback.year
        return year if 1970 <= year <= 2200 else fallback.year

    def _read_dates(payload) -> list[date]:
        raw = payload.get("dates")
        if isinstance(raw, str):
            raw = [raw]
        if not isinstance(raw, list) or not raw:
            raise ValueError("Aucune date fournie.")
        if len(raw) > 400:
            raise ValueError("Trop de dates dans une seule requête (max 400).")
        try:
            return sorted({parse_iso(d) for d in raw})
        except (ValueError, TypeError, AttributeError):
            raise ValueError("Format de date invalide (attendu AAAA-MM-JJ).")

    @app.post("/api/entries")
    @editor_required
    def api_save_entries():
        payload = request.get_json(silent=True) or {}
        try:
            days = _read_dates(payload)
        except ValueError as exc:
            return jsonify(error=str(exc)), 400

        set_owner = "owner" in payload
        owner = payload.get("owner") or None
        if set_owner and owner is not None and owner not in PEOPLE:
            return jsonify(error="Gardien inconnu : %s" % owner), 400

        set_note = "note" in payload
        note = (payload.get("note") or "").strip()[:500] or None

        existing = {
            row.day: row for row in DayEntry.query.filter(DayEntry.day.in_(days)).all()
        }

        for day in days:
            row = existing.get(day)
            if row is None:
                if (set_owner and owner) or (set_note and note):
                    row = DayEntry(
                        day=day,
                        owner=owner if set_owner else None,
                        note=note if set_note else None,
                    )
                    db.session.add(row)
                continue
            if set_owner:
                row.owner = owner
            if set_note:
                row.note = note
            if row.is_empty:
                db.session.delete(row)

        db.session.commit()
        return jsonify(
            entries=entries_between(days[0], days[-1]),
            stats=build_stats(_stats_year(payload, days[0])),
        )

    @app.delete("/api/entries")
    @editor_required
    def api_clear_entries():
        payload = request.get_json(silent=True) or {}
        try:
            days = _read_dates(payload)
        except ValueError as exc:
            return jsonify(error=str(exc)), 400

        DayEntry.query.filter(DayEntry.day.in_(days)).delete(synchronize_session=False)
        db.session.commit()
        return jsonify(
            entries=entries_between(days[0], days[-1]),
            stats=build_stats(_stats_year(payload, days[0])),
        )

    @app.post("/api/reset")
    @editor_required
    def api_reset():
        """Vide la base et recree le schema a neuf.

        Action irreversible : elle exige la phrase de confirmation exacte, pour
        qu'un appel accidentel (ou un clic de trop) ne puisse pas effacer
        l'historique de garde.
        """
        payload = request.get_json(silent=True) or {}
        if (payload.get("confirm") or "").strip().upper() != RESET_PHRASE:
            return (
                jsonify(
                    error="Confirmation manquante : renvoyez "
                    '{"confirm": "%s"} pour réinitialiser.' % RESET_PHRASE
                ),
                400,
            )

        removed = DayEntry.query.count()

        # Reconstruction complete du schema, pas un simple DELETE : on repart
        # d'une base identique a celle d'un premier demarrage.
        db.session.close()
        db.drop_all()
        db.create_all()
        db.session.commit()

        app.logger.warning("Base reinitialisee : %d journee(s) supprimee(s).", removed)
        return jsonify(
            ok=True,
            removed=removed,
            stats=build_stats(_stats_year(payload, date.today())),
        )

    def sqlite_file() -> str | None:
        """Chemin du fichier SQLite, ou None si la base n'en est pas une."""
        uri = app.config["SQLALCHEMY_DATABASE_URI"]
        prefix = "sqlite:///"
        return uri[len(prefix):] if uri.startswith(prefix) else None

    # L'export est un lien que le navigateur suit : hors de /api/ pour qu'une
    # session expiree renvoie vers la page de connexion plutot qu'un JSON brut.
    @app.get("/export")
    @editor_required
    def export_db():
        path = sqlite_file()
        if not path or not os.path.exists(path):
            return (
                render_template(
                    "error.html",
                    code=400,
                    message="L'export de fichier n'est possible qu'avec une base SQLite.",
                ),
                400,
            )

        db.session.commit()

        # Copie par l'API de sauvegarde SQLite : donne un instantane coherent
        # meme si une ecriture est en cours, contrairement a une copie brute.
        handle, tmp = tempfile.mkstemp(suffix=".sqlite3")
        os.close(handle)
        try:
            source = sqlite3.connect(path)
            target = sqlite3.connect(tmp)
            try:
                with target:
                    source.backup(target)
            finally:
                target.close()
                source.close()
            with open(tmp, "rb") as fh:
                blob = fh.read()
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass

        return send_file(
            io.BytesIO(blob),
            as_attachment=True,
            download_name="dex-%s.sqlite3" % date.today().isoformat(),
            mimetype="application/vnd.sqlite3",
        )

    @app.post("/api/import")
    @editor_required
    def api_import():
        upload = request.files.get("file")
        if upload is None or not upload.filename:
            return jsonify(error="Aucun fichier fourni."), 400

        handle, tmp = tempfile.mkstemp(suffix=".sqlite3")
        os.close(handle)
        try:
            upload.save(tmp)
            rows = read_entries_from_sqlite(tmp)
        except ValueError as exc:
            return jsonify(error=str(exc)), 400
        except sqlite3.Error:
            return jsonify(error="Fichier de base illisible."), 400
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass

        # Le contenu importe remplace l'existant : on repart d'un schema neuf
        # plutot que de fusionner, pour que le resultat soit exactement le
        # fichier fourni.
        db.session.close()
        db.drop_all()
        db.create_all()
        db.session.add_all(
            DayEntry(day=r["day"], owner=r["owner"], note=r["note"]) for r in rows
        )
        db.session.commit()

        app.logger.warning("Base importee : %d journee(s).", len(rows))
        return jsonify(
            ok=True,
            imported=len(rows),
            # L'annee affichee arrive dans le formulaire, l'envoi etant multipart.
            stats=build_stats(_stats_year(request.form, date.today())),
        )

    @app.get("/healthz")
    def healthz():
        db.session.execute(db.text("SELECT 1"))
        return jsonify(status="ok", dog="DEX")

    # ------------------------------ erreurs -------------------------------- #

    @app.errorhandler(413)
    def too_large(_):
        limit = MAX_IMPORT_BYTES // (1024 * 1024)
        if request.path.startswith("/api/"):
            return jsonify(error="Fichier trop volumineux (max %d Mo)." % limit), 413
        return (
            render_template(
                "error.html",
                code=413,
                message="Fichier trop volumineux (max %d Mo)." % limit,
            ),
            413,
        )

    @app.errorhandler(404)
    def not_found(_):
        return (
            render_template(
                "error.html",
                code=404,
                message="Cette page a été enterrée dans le jardin.",
            ),
            404,
        )

    @app.errorhandler(500)
    def server_error(_):
        db.session.rollback()
        return (
            render_template(
                "error.html", code=500, message="DEX a mâché un câble. Réessayez."
            ),
            500,
        )

    return app


app = create_app()


if __name__ == "__main__":
    app.run(
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "5000")),
        debug=os.environ.get("FLASK_DEBUG", "0") == "1",
    )

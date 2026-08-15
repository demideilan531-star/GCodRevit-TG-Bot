import hashlib
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from PIL import Image, ImageDraw, ImageFont


TIMEZONE = ZoneInfo(os.getenv("REPORT_TIMEZONE", "Europe/Moscow"))
IMAGE_PATH = Path(os.getenv("GITHUB_IMAGE_PATH", "/tmp/github_report.png"))
CAPTION_PATH = Path(os.getenv("GITHUB_CAPTION_PATH", "/tmp/github_caption.txt"))

BACKGROUND = "#08131f"
PANEL = "#10263a"
PANEL_ALT = "#123451"
INK = "#f5f7fa"
MUTED = "#9fb2c3"
CYAN = "#4cb7e8"
GREEN = "#58d49b"
CORAL = "#ff755f"
YELLOW = "#ffc857"
PURPLE = "#9d82ff"

JOKES = (
    "Пока кто-то считает клики, мы считаем коммиты.",
    "Репозиторий проверен. Ручная археология снова не понадобилась.",
    "Код сам себя не проверит. Поэтому мы уже проверили.",
    "Изменения разложены по полкам. Да, без Excel на три экрана.",
)


def load_report():
    raw = os.getenv("GITHUB_REPORT_JSON", "").strip()
    path = os.getenv("GITHUB_REPORT_JSON_PATH", "").strip()
    if path:
        raw = Path(path).read_text(encoding="utf-8")
    if not raw:
        raise RuntimeError("Не переданы данные GitHub-отчёта")
    report = json.loads(raw)
    if not isinstance(report, dict):
        raise RuntimeError("GitHub-отчёт должен быть JSON-объектом")
    return normalize_report(report)


def integer(value, default=0):
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return default


def short_text(value, limit):
    value = " ".join(str(value or "").split())
    if len(value) <= limit:
        return value
    return value[: max(1, limit - 1)].rstrip() + "…"


def normalize_report(report):
    areas = []
    for item in report.get("areas", []):
        if not isinstance(item, dict):
            continue
        name = short_text(item.get("name"), 28)
        count = integer(item.get("count"))
        if name and count:
            areas.append({"name": name, "count": count})
    areas.sort(key=lambda item: (-item["count"], item["name"]))

    highlights = [
        short_text(item, 90)
        for item in report.get("highlights", [])
        if short_text(item, 90)
    ][:4]
    if not highlights:
        highlights = ["Репозиторий доступен, структура проекта проверена."]

    mode = "snapshot" if report.get("mode") == "snapshot" else "changes"
    generated_at = str(report.get("generated_at") or "")
    try:
        generated = datetime.fromisoformat(generated_at.replace("Z", "+00:00")).astimezone(TIMEZONE)
    except ValueError:
        generated = datetime.now(TIMEZONE)

    files_changed = report.get("files_changed", 0)
    if isinstance(files_changed, str) and files_changed.endswith("+"):
        files_label = files_changed
    else:
        files_label = str(integer(files_changed))

    return {
        "mode": mode,
        "variant": short_text(report.get("variant"), 24) or "default",
        "repository": short_text(report.get("repository"), 80) or "GCodRevit",
        "branch": short_text(report.get("branch"), 40) or "main",
        "generated": generated,
        "head_sha": short_text(report.get("head_sha"), 40),
        "commits_count": integer(report.get("commits_count")),
        "files_changed": files_label,
        "additions": integer(report.get("additions")),
        "deletions": integer(report.get("deletions")),
        "areas": areas[:6],
        "highlights": highlights,
        "period_start": short_text(report.get("period_start"), 40),
        "period_end": short_text(report.get("period_end"), 40),
        "truncated": bool(report.get("truncated")),
    }


def font_path(bold=False):
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
        if bold
        else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
    ]
    return next((path for path in candidates if Path(path).exists()), candidates[0])


def font(size, bold=False):
    return ImageFont.truetype(font_path(bold), size)


def wrap_lines(draw, text, selected_font, max_width, max_lines):
    words = str(text).split()
    lines = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if draw.textbbox((0, 0), candidate, font=selected_font)[2] <= max_width:
            current = candidate
            continue
        if current:
            lines.append(current)
        current = word
    if current:
        lines.append(current)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        while lines[-1] and draw.textbbox((0, 0), lines[-1] + "…", font=selected_font)[2] > max_width:
            lines[-1] = lines[-1][:-1]
        lines[-1] += "…"
    return lines


def draw_wrapped(draw, xy, text, selected_font, fill, max_width, max_lines=2, spacing=6):
    lines = wrap_lines(draw, text, selected_font, max_width, max_lines)
    draw.multiline_text(xy, "\n".join(lines), font=selected_font, fill=fill, spacing=spacing)
    return len(lines)


def deterministic_joke(report):
    seed = f"{report['head_sha']}:{report['variant']}:{report['commits_count']}"
    number = int(hashlib.sha256(seed.encode("utf-8")).hexdigest()[:8], 16)
    return JOKES[number % len(JOKES)]


def number_label(value):
    return f"{integer(value):,}".replace(",", " ")


def headline(report):
    if report["variant"] == "architecture":
        return "GCodRevit собран в систему. Хаос не прошёл ревью."
    if report["mode"] == "snapshot":
        return "Проект на месте. Всё важное уже разложено по модулям."
    return "GCodRevit обновился. Ручной труд снова немного проиграл."


def fitted_font(draw, text, max_width, start_size=54, min_size=30, bold=True):
    for size in range(start_size, min_size - 1, -1):
        selected = font(size, bold)
        if draw.textbbox((0, 0), str(text), font=selected)[2] <= max_width:
            return selected
    return font(min_size, bold)


def draw_metric(draw, x, label, value, accent):
    draw.rounded_rectangle((x, 260, x + 344, 406), radius=18, fill=PANEL)
    draw.rectangle((x, 260, x + 8, 406), fill=accent)
    draw.text((x + 30, 284), label, font=font(20, True), fill=MUTED)
    value_font = fitted_font(draw, value, 284)
    draw.text((x + 30, 323), str(value), font=value_font, fill=INK)


def build_image(report):
    image = Image.new("RGB", (1200, 900), BACKGROUND)
    draw = ImageDraw.Draw(image)
    generated = report["generated"]

    draw.text((48, 38), "GCODREVIT / GITHUB", font=font(27, True), fill=INK)
    draw.rounded_rectangle((940, 34, 1152, 76), radius=18, fill=PANEL_ALT)
    draw.text((1046, 55), "ОТЧЁТ ГОТОВ", font=font(17, True), fill=GREEN, anchor="mm")
    draw.line((48, 94, 1152, 94), fill="#24445e", width=2)

    draw_wrapped(draw, (48, 125), headline(report), font(43, True), INK, 1080, 2, 8)
    branch_line = (
        f"Ветка {report['branch']} • {generated.strftime('%d.%m.%Y, %H:%M')} МСК"
    )
    draw.text((48, 221), branch_line, font=font(21), fill=MUTED)

    draw_metric(draw, 48, "КОММИТОВ", report["commits_count"], CYAN)
    draw_metric(draw, 428, "ИЗМЕНЕНИЙ ФАЙЛОВ", report["files_changed"], GREEN)
    line_value = f"+{number_label(report['additions'])} / -{number_label(report['deletions'])}"
    draw_metric(draw, 808, "СТРОКИ", line_value, CORAL)

    draw.rounded_rectangle((48, 438, 730, 800), radius=18, fill=PANEL)
    draw.text((78, 468), "ГДЕ БЫЛА РАБОТА", font=font(22, True), fill=INK)
    areas = report["areas"] or [{"name": "Проект", "count": 1}]
    maximum = max(item["count"] for item in areas)
    colors = (CYAN, GREEN, PURPLE, YELLOW, CORAL, MUTED)
    for index, item in enumerate(areas[:6]):
        y = 518 + index * 45
        draw.text((78, y), item["name"], font=font(19, True), fill=INK)
        draw.text((676, y), str(item["count"]), font=font(19, True), fill=MUTED, anchor="ra")
        draw.rounded_rectangle((325, y + 7, 640, y + 20), radius=6, fill="#1e3b52")
        width = max(12, int(315 * item["count"] / maximum))
        draw.rounded_rectangle((325, y + 7, 325 + width, y + 20), radius=6, fill=colors[index])

    draw.rounded_rectangle((760, 438, 1152, 800), radius=18, fill=PANEL_ALT)
    draw.text((790, 468), "ГЛАВНОЕ", font=font(22, True), fill=INK)
    y = 516
    for item in report["highlights"][:4]:
        draw.ellipse((790, y + 7, 800, y + 17), fill=GREEN)
        count = draw_wrapped(draw, (816, y), item, font(18), INK, 300, 3, 4)
        y += 40 + count * 20
        if y > 746:
            break

    draw.line((48, 832, 1152, 832), fill="#24445e", width=2)
    draw.text((48, 853), deterministic_joke(report), font=font(18), fill=MUTED)
    draw.text((1152, 853), "МЫ ЭТО РУКАМИ НЕ ДЕЛАЕМ", font=font(18, True), fill=GREEN, anchor="ra")

    IMAGE_PATH.parent.mkdir(parents=True, exist_ok=True)
    image.save(IMAGE_PATH, format="PNG", optimize=True)


def build_caption(report):
    generated = report["generated"]
    lines = [
        "🧩 GCodRevit: отчёт по GitHub",
        f"🕒 {generated.strftime('%d.%m.%Y, %H:%M')} МСК",
        "",
        headline(report),
        "",
        "Что изменилось:",
    ]
    lines.extend(f"• {item}" for item in report["highlights"][:4])
    lines.extend(
        [
            "",
            (
                f"По масштабу: {report['commits_count']} комм., "
                f"{report['files_changed']} изм. файлов, "
                f"+{number_label(report['additions'])} / -{number_label(report['deletions'])} строк."
            ),
        ]
    )
    if report["areas"]:
        focus = ", ".join(item["name"] for item in report["areas"][:3])
        lines.append(f"Фокус: {focus}.")
    if report["truncated"]:
        lines.append("Масштаб крупный: в сводку вошла репрезентативная выборка файлов.")
    lines.extend(["", deterministic_joke(report), "Мы это руками не делаем."])
    caption = "\n".join(lines)
    CAPTION_PATH.parent.mkdir(parents=True, exist_ok=True)
    CAPTION_PATH.write_text(caption[:1024], encoding="utf-8")


def main():
    report = load_report()
    build_image(report)
    build_caption(report)
    print(
        f"GitHub report built: {report['commits_count']} commits, "
        f"{report['files_changed']} file changes"
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"GitHub report failed: {error}", file=sys.stderr)
        raise


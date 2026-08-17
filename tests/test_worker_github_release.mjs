import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../cloudflare-worker/src/index.js", import.meta.url),
  "utf8",
);
const worker = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);

const assets = Array.from({ length: 10 }, (_, index) => ({
  name: `asset-${index + 1}.zip`,
  updated_at: "2026-08-16T07:11:13Z",
}));

const releases = [
  {
    tag_name: "v1.0.103",
    name: "GCod 1.0.103",
    draft: false,
    published_at: "2026-08-14T10:00:00Z",
    updated_at: "2026-08-14T10:00:00Z",
    body: "- Исправлена проверка лицензии после защиты DLL.",
    assets: [{ name: "GCod-1.0.103.exe", updated_at: "2026-08-14T10:00:00Z" }],
  },
  {
    tag_name: "v1.0.104",
    name: "GCod 1.0.104",
    draft: true,
    created_at: "2026-08-16T06:50:57Z",
    updated_at: "2026-08-16T06:51:22Z",
    html_url: "https://github.com/example/releases/1",
    body: [
      "- Добавлена подписанная машинно-привязанная офлайн-лицензия для Navisworks.",
      "- Управляемые сборки Desktop, Revit и Navisworks защищены обфускацией; целостность пакетов проверяется при выпуске.",
      "- Ошибки экспортёра NWC теперь перехватываются во время экспорта и передаются в структурированный результат/API.",
      "- Конвейер RNC сохраняет последовательность: очистка RVT → сохранение и закрытие → повторное открытие → экспорт NWC.",
    ].join("\n"),
    assets,
  },
  {
    tag_name: "v1.0.104",
    name: "GCod 1.0.104",
    draft: true,
    created_at: "2026-08-16T07:10:49Z",
    updated_at: "2026-08-16T07:11:13Z",
    html_url: "https://github.com/example/releases/2",
    body: [
      "- Подписанная офлайн-лицензия Navisworks.",
      "- Усиленная защита управляемых DLL и контроль целостности пакетов.",
      "- Более безопасная установка и обновление компонентов.",
    ].join("\n"),
    assets,
  },
];

assert.equal(worker.compareVersions("v1.0.104", "v1.0.103"), 1);

const merged = worker.mergeGithubReleases([releases[0]], releases);
assert.equal(merged.length, 2);
assert.equal(merged[0].tag_name, "v1.0.104");

const groups = worker.groupGithubReleases(releases);
assert.equal(groups[0].version, "v1.0.104");
assert.equal(groups[0].releases.length, 2);
assert.equal(groups[0].assets.length, 10);

const report = worker.buildGithubReleaseReport(
  releases,
  "demideilan531-star/GCod-",
  "main",
  Date.parse("2026-08-01T00:00:00Z"),
);
assert.equal(report.release_version, "v1.0.104");
assert.equal(report.report_title, "GCod 1.0.104: что изменилось");
assert.equal(report.baseline_note, "Сравнение: 1.0.103 → 1.0.104.");
assert.equal(report.technical.duplicate_releases, 2);
assert.equal(report.changes.length, 3);
assert.deepEqual(
  report.changes.map((change) => change.id),
  ["navisworks-offline-license", "protected-builds", "nwc-errors"],
);

const manifestReport = worker.buildGithubManifestReport(
  {
    schemaVersion: 1,
    version: "1.0.104",
    summary: "Версия для пользователей, а не отчёт о количестве файлов.",
    source: { commit: "abc123" },
    changes: [
      {
        status: "new",
        title: "Офлайн-лицензия Navisworks",
        what: "Лицензия работает без постоянного соединения.",
        how: "Обнови GCod и активируй Navisworks на компьютере.",
        why: "Работа не останавливается при временной недоступности сервера.",
      },
    ],
    artifacts: [{ name: "GCodSetup-1.0.104.exe" }],
  },
  groups[0],
  groups[1],
  "demideilan531-star/GCod-",
  "main",
);

assert.equal(manifestReport.variant, "release-manifest");
assert.equal(manifestReport.head_sha, "abc123");
assert.equal(manifestReport.changes[0].status, "new");
assert.equal(manifestReport.technical.manifest_artifacts, 1);

console.log("GitHub release report tests passed.");

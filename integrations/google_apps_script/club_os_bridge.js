/**
 * Add as a NEW .gs file in the existing Club Apps Script project.
 * Do not replace doGet/doPost or BotHelp/MoySklad code.
 * Script Properties: RASPECHATKA_OS_SECRET (>=32 characters).
 * First run clubOSPreview(), then clubOSInstall() after a successful preview.
 * Polling reconciles script writes AND manual edits. No browser dual-write.
 */
const CLUB_OS = Object.freeze({
	url: "https://os.rpechatka.ru/api/method/raspechatka.api.club_shadow.receive",
	queue: "Очередь Raspechatka OS",
	batch: 15,
	headers: [
		"Event ID",
		"Client ID",
		"Hash",
		"Payload",
		"Status",
		"Attempts",
		"Error",
		"Sent at",
	],
});

function clubOSObjects_(sheet) {
	if (!sheet) throw new Error("Не найден обязательный лист");
	const values = sheet.getDataRange().getValues();
	const names = values.shift();
	return values
		.filter((row) => row.some((v) => v !== "" && v !== null))
		.map((row) => {
			const result = {};
			names.forEach((key, index) => {
				if (!key) return;
				const v = row[index];
				result[key] =
					v instanceof Date
						? Utilities.formatDate(
								v,
								SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(),
								"yyyy-MM-dd HH:mm:ss"
						  )
						: v;
			});
			return result;
		});
}

function clubOSHex_(bytes) {
	return bytes.map((b) => ("0" + ((b + 256) % 256).toString(16)).slice(-2)).join("");
}

function clubOSHash_(text) {
	return clubOSHex_(
		Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
	);
}

function clubOSSnapshot_() {
	const ss = SpreadsheetApp.getActiveSpreadsheet();
	const clients = clubOSObjects_(ss.getSheetByName("Клиенты")).filter((c) => c["Client ID"]);
	const grouped = {};
	[
		["channels", "Каналы"],
		["consents", "Согласия"],
		["events", "Лог событий"],
	].forEach(([kind, title]) => {
		grouped[kind] = {};
		clubOSObjects_(ss.getSheetByName(title)).forEach((row) => {
			const id = String(row["Client ID"] || "").trim();
			if (!id) return;
			if (kind === "events") {
				delete row["Краткие данные"]; // Old raw logs can contain bearer tokens.
				delete row["Ошибка"];
			}
			(grouped[kind][id] || (grouped[kind][id] = [])).push(row);
		});
	});
	const seen = new Set();
	return clients.map((client) => {
		const id = String(client["Client ID"]).trim();
		if (seen.has(id)) throw new Error("Повтор Client ID в листе Клиенты");
		seen.add(id);
		return {
			client,
			channels: grouped.channels[id] || [],
			consents: grouped.consents[id] || [],
			events: grouped.events[id] || [],
		};
	});
}

function clubOSQueue_() {
	const ss = SpreadsheetApp.getActiveSpreadsheet();
	let sheet = ss.getSheetByName(CLUB_OS.queue);
	if (!sheet) {
		sheet = ss.insertSheet(CLUB_OS.queue);
		sheet.appendRow(CLUB_OS.headers);
		sheet.setFrozenRows(1);
		sheet.hideColumns(4);
	}
	return sheet;
}

function clubOSEnvelope_(snapshot, preview) {
	return Object.assign(
		{
			version: 1,
			source_id: SpreadsheetApp.getActiveSpreadsheet().getId(),
			event_id: Utilities.getUuid(),
			revision: Date.now(),
			state_hash: clubOSHash_(JSON.stringify(snapshot)),
			dry_run: Boolean(preview),
		},
		snapshot
	);
}

function clubOSSend_(payload) {
	const secret =
		PropertiesService.getScriptProperties().getProperty("RASPECHATKA_OS_SECRET") || "";
	if (secret.length < 32) throw new Error("Задайте RASPECHATKA_OS_SECRET в свойствах скрипта");
	const timestamp = String(Math.floor(Date.now() / 1000));
	const signature = clubOSHex_(
		Utilities.computeHmacSha256Signature(
			timestamp + "\n" + payload,
			secret,
			Utilities.Charset.UTF_8
		)
	);
	const response = UrlFetchApp.fetch(CLUB_OS.url, {
		method: "post",
		contentType: "application/json",
		payload: JSON.stringify({ payload, timestamp, signature }),
		muteHttpExceptions: true,
	});
	if (response.getResponseCode() !== 200)
		throw new Error("OS HTTP " + response.getResponseCode());
	const decoded = JSON.parse(response.getContentText());
	const result = decoded.message || decoded;
	if (!result.ok) throw new Error(result.error || "OS отклонила событие");
	return result;
}

function clubOSPreview() {
	const snapshot = clubOSSnapshot_()[0];
	if (!snapshot) throw new Error("Нет клиентов для проверки");
	const result = clubOSSend_(JSON.stringify(clubOSEnvelope_(snapshot, true)));
	console.log(JSON.stringify(result)); // No client information or credentials.
}

function clubOSInstall() {
	const props = PropertiesService.getScriptProperties();
	if ((props.getProperty("RASPECHATKA_OS_SECRET") || "").length < 32)
		throw new Error("Сначала задайте ключ");
	clubOSQueue_();
	if (!ScriptApp.getProjectTriggers().some((t) => t.getHandlerFunction() === "clubOSTick")) {
		ScriptApp.newTrigger("clubOSTick").timeBased().everyMinutes(1).create();
	}
	props.setProperty("CLUB_OS_ENABLED", "1");
}

function clubOSPause() {
	PropertiesService.getScriptProperties().setProperty("CLUB_OS_ENABLED", "0");
}

function clubOSTick() {
	const props = PropertiesService.getScriptProperties();
	if (props.getProperty("CLUB_OS_ENABLED") !== "1") return;
	const lock = LockService.getScriptLock();
	if (!lock.tryLock(1000)) return;
	try {
		const sheet = clubOSQueue_();
		const pending = clubOSObjects_(sheet);
		const pendingIds = new Set(
			pending.filter((r) => r.Status !== "SENT").map((r) => String(r["Client ID"]))
		);
		let added = 0;
		const snapshots = clubOSSnapshot_();
		for (const snapshot of snapshots) {
			const id = String(snapshot.client["Client ID"]);
			if (pendingIds.has(id)) continue;
			const hash = clubOSHash_(JSON.stringify(snapshot));
			if (props.getProperty("CLUB_OS_HASH_" + id) === hash) continue;
			const data = clubOSEnvelope_(snapshot, false);
			const payload = JSON.stringify(data);
			if (payload.length > 45000)
				throw new Error(
					"Снимок клиента превышает лимит ячейки; требуется пакетный импорт истории"
				);
			sheet.appendRow([data.event_id, id, hash, payload, "PENDING", 0, "", ""]);
			if (++added >= CLUB_OS.batch) break;
		}
		SpreadsheetApp.flush();
		const rows = sheet.getDataRange().getValues();
		let sent = 0;
		for (let i = 1; i < rows.length && sent < CLUB_OS.batch; i++) {
			const row = rows[i];
			if (row[4] === "SENT") continue;
			if (
				row[4] === "ERROR" &&
				row[7] instanceof Date &&
				Date.now() - row[7].getTime() <
					Math.min(3600000, 60000 * Math.pow(2, Math.min(Number(row[5]), 6)))
			)
				continue;
			try {
				const result = clubOSSend_(String(row[3]));
				props.setProperty("CLUB_OS_HASH_" + row[1], String(row[2]));
				sheet
					.getRange(i + 1, 5, 1, 4)
					.setValues([
						[
							"SENT",
							Number(row[5]) + 1,
							result.outcome === "DIFFERENCE" ? "Расхождение скидки/каналов" : "",
							new Date(),
						],
					]);
				sheet.getRange(i + 1, 4).clearContent(); // Remove tokens after acknowledgement.
			} catch (error) {
				sheet
					.getRange(i + 1, 5, 1, 4)
					.setValues([
						[
							"ERROR",
							Number(row[5]) + 1,
							String(error.message).slice(0, 200),
							new Date(),
						],
					]);
			}
			sent++;
		}
	} finally {
		lock.releaseLock();
	}
}

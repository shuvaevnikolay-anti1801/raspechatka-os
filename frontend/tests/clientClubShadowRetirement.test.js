import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../src/pages/ClientClubPage.vue", import.meta.url), "utf8");
const clients = readFileSync(new URL("../src/pages/ClientsPage.vue", import.meta.url), "utf8");
const shadowPanel = new URL("../src/components/ClubShadowPanel.vue", import.meta.url);

test("club workspace has no Google shadow controls or API calls", () => {
	assert.doesNotMatch(page, /ClubShadowPanel|club_shadow|Параллельный перенос из Google/);
	assert.equal(existsSync(shadowPanel), false);
});

test("legacy clients remain editable in the canonical OS client card", () => {
	assert.doesNotMatch(clients, /!form\.legacy_club_id|Параллельная копия Google/);
	assert.match(clients, /v-if="canEdit && \(tab === 'profile' \|\| tab === 'club'\)"/);
});

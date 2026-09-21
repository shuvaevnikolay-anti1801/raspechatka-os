export function createListReadyGate(start) {
	let filterReady = false;
	let tableReady = false;
	let started = false;
	let pageSize = 25;

	const maybeStart = () => {
		if (started || !filterReady || !tableReady) return undefined;
		started = true;
		return start(pageSize);
	};

	return {
		filter() {
			filterReady = true;
			return maybeStart();
		},
		table(size) {
			pageSize = Number(size) || 25;
			tableReady = true;
			return maybeStart();
		},
		reset() {
			filterReady = false;
			tableReady = false;
			started = false;
			pageSize = 25;
		},
	};
}

export function createLatestRequestGate() {
	let generation = 0;
	return {
		begin() {
			generation += 1;
			return generation;
		},
		isCurrent(token) {
			return token === generation;
		},
		invalidate() {
			generation += 1;
		},
	};
}

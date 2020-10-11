const fs = require("fs");

const chalk = require("chalk");
const { getRuntimeConfig } = require("./configuration");
const { stripExtension } = require("./utils");
const {
	loadTorrentDir,
	saveTorrentFile,
	getInfoHashesToExclude,
	getTorrentByName,
} = require("./torrent");
const { filterTorrentFile, filterDupes } = require("./preFilter");
const { assessResult } = require("./decide");
const { makeJackettRequest, validateJackettApi } = require("./jackett");

async function findOnOtherSites(info, hashesToExclude) {
	const assessEach = (result) => assessResult(result, info, hashesToExclude);

	const query = stripExtension(info.name);
	let response;
	try {
		response = await makeJackettRequest(query);
	} catch (e) {
		console.error(chalk.red`error querying Jackett for ${query}`);
		return 0;
	}
	const results = response.data.Results;

	const loaded = await Promise.all(results.map(assessEach));
	const successful = loaded.filter((e) => e !== null);

	successful.forEach(({ tracker, tag, info: newInfo }) => {
		const styledName = chalk.green.bold(newInfo.name);
		const styledTracker = chalk.bold(tracker);
		console.log(`Found ${styledName} on ${styledTracker}`);
		saveTorrentFile(tracker, tag, newInfo);
	});

	return successful.length;
}

async function findMatchesBatch(samples, hashesToExclude) {
	const { delay } = getRuntimeConfig();

	let totalFound = 0;
	for (const [i, sample] of samples.entries()) {
		const sleep = new Promise((r) => setTimeout(r, delay * 1000));

		const progress = chalk.blue(`[${i + 1}/${samples.length}]`);
		const name = stripExtension(sample.name);
		console.log(progress, chalk.dim("Searching for"), name);

		let numFoundPromise = findOnOtherSites(sample, hashesToExclude);
		const [numFound] = await Promise.all([numFoundPromise, sleep]);
		totalFound += numFound;
	}
	return totalFound;
}

async function searchForSingleTorrentByName(name) {
	const hashesToExclude = getInfoHashesToExclude();
	const meta = getTorrentByName(name);
	return findOnOtherSites(meta, hashesToExclude);
}

async function main() {
	const { offset, outputDir } = getRuntimeConfig();
	const parsedTorrents = loadTorrentDir();
	const hashesToExclude = parsedTorrents.map((t) => t.infoHash);
	const filteredTorrents = filterDupes(parsedTorrents).filter(
		filterTorrentFile
	);
	const samples = filteredTorrents.slice(offset);

	console.log(
		"Found %d torrents, %d suitable to search for matches",
		parsedTorrents.length,
		filteredTorrents.length
	);

	try {
		await validateJackettApi();
	} catch (e) {
		return;
	}

	if (offset > 0) console.log("Starting at", offset);

	fs.mkdirSync(outputDir, { recursive: true });
	let totalFound = await findMatchesBatch(samples, hashesToExclude);

	console.log(
		chalk.cyan("Done! Found %s cross seeds from %s original torrents"),
		chalk.bold.white(totalFound),
		chalk.bold.white(samples.length)
	);
}

module.exports = { main, searchForSingleTorrentByName };

import { fileFrom } from "fetch-blob/from.js";
import { FormData } from "formdata-polyfill/esm.min.js";
import { statSync } from "fs";
import { unlink, writeFile } from "fs/promises";
import fetch, { BodyInit, Response } from "node-fetch";
import { tmpdir } from "os";
import parseTorrent, { Metafile } from "parse-torrent";
import { basename, dirname, join, posix, sep } from "path";
import { dataMode } from "../config.template.cjs";
import { InjectionResult, RenameResult } from "../constants.js";
import { CrossSeedError } from "../errors.js";
import { Label, logger } from "../logger.js";
import { getRuntimeConfig } from "../runtimeConfig.js";
import { Searchee } from "../searchee.js";
import { isSingleFileTorrent } from "../torrent.js";
import { TorrentClient } from "./TorrentClient.js";

const X_WWW_FORM_URLENCODED = {
	"Content-Type": "application/x-www-form-urlencoded",
};

interface TorrentInfo {
	added_on: number;
	amount_left: number;
	auto_tmm: boolean;
	availability: number;
	category: string;
	completed: number;
	completion_on: number;
	content_path: string;
	dl_limit: number;
	dlspeed: number;
	download_path: string;
	downloaded: number;
	downloaded_session: number;
	eta: number;
	f_l_piece_prio: boolean;
	force_start: boolean;
	hash: string;
	infohash_v1: string;
	infohash_v2: string;
	last_activity: number;
	magnet_uri: string;
	max_ratio: number;
	max_seeding_time: number;
	name: string;
	num_complete: number;
	num_incomplete: number;
	num_leechs: number;
	num_seeds: number;
	priority: number;
	progress: number;
	ratio: number;
	ratio_limit: number;
	save_path: string;
	seeding_time: number;
	seeding_time_limit: number;
	seen_complete: number;
	seq_dl: boolean;
	size: number;
	state: string;
	super_seeding: boolean;
	tags: string;
	time_active: number;
	total_size: number;
	tracker: string;
	trackers_count: number;
	up_limit: number;
	uploaded: number;
	uploaded_session: number;
	upspeed: number;
}

interface TorrentFiles {
	availability: number;
	index: number;
	is_seed: boolean;
	name: string;
	piece_range: [number, number];
	priority: number;
	progress: number;
	size: number;
}

interface Category {
	name: string;
	savePath: string;
}

export default class QBittorrent implements TorrentClient {
	url: URL;
	cookie: string;

	constructor() {
		const { qbittorrentUrl } = getRuntimeConfig();
		try {
			this.url = new URL(`${qbittorrentUrl}/api/v2`);
		} catch (e) {
			throw new CrossSeedError("qBittorrent url must be percent-encoded");
		}
	}

	async login(): Promise<void> {
		const { origin, pathname, username, password } = this.url;

		let searchParams;
		try {
			searchParams = new URLSearchParams({
				username: decodeURIComponent(username),
				password: decodeURIComponent(password),
			});
		} catch (e) {
			throw new CrossSeedError("qBittorrent url must be percent-encoded");
		}

		let response: Response;
		try {
			response = await fetch(
				`${origin}${pathname}/auth/login?${searchParams}`
			);
		} catch (e) {
			throw new CrossSeedError(`qBittorrent login failed: ${e.message}`);
		}

		if (response.status !== 200) {
			throw new CrossSeedError(
				`qBittorrent login failed with code ${response.status}`
			);
		}

		const cookieArray = response.headers.raw()["set-cookie"];
		if (cookieArray) {
			this.cookie = cookieArray[0].split(";")[0];
		} else {
			throw new CrossSeedError(
				`qBittorrent login failed: Invalid username or password`
			);
		}
	}

	async validateConfig(): Promise<void> {
		await this.login();
		await this.createTag();
	}

	private async request(
		path: string,
		body: BodyInit,
		headers: Record<string, string> = {},
		retries = 1
	): Promise<string> {
		logger.verbose({
			label: Label.QBITTORRENT,
			message: `Making request to ${path} with body ${body.toString()}`,
		});
		const { origin, pathname } = this.url;
		const response = await fetch(`${origin}${pathname}${path}`, {
			method: "post",
			headers: { Cookie: this.cookie, ...headers },
			body,
		});
		if (response.status === 403 && retries > 0) {
			logger.verbose({
				label: Label.QBITTORRENT,
				message: "received 403 from API. Logging in again and retrying",
			});
			await this.login();
			return this.request(path, body, headers, retries - 1);
		}
		return response.text();
	}

	async setUpCrossSeedCategory(ogCategoryName: string): Promise<string> {
		if (!ogCategoryName) return "";
		if (ogCategoryName.endsWith(".cross-seed")) return ogCategoryName;

		const categoriesStr = await this.request("/torrents/categories", "");
		const categories: Record<string, Category> = JSON.parse(categoriesStr);
		const ogCategory = categories[ogCategoryName];
		const newCategoryName = `${ogCategoryName}.cross-seed`;
		const maybeNewCategory = categories[newCategoryName];

		if (maybeNewCategory?.savePath === ogCategory.savePath) {
			// setup is already complete
		} else if (maybeNewCategory) {
			await this.request(
				"/torrents/editCategory",
				`category=${newCategoryName}&savePath=${ogCategory.savePath}`,
				X_WWW_FORM_URLENCODED
			);
		} else {
			await this.request(
				"/torrents/createCategory",
				`category=${newCategoryName}&savePath=${ogCategory.savePath}`,
				X_WWW_FORM_URLENCODED
			);
		}
		return newCategoryName;
	}

	async createTag(): Promise<void> {
		await this.request(
			"/torrents/createTags",
			"tags=cross-seed",
			X_WWW_FORM_URLENCODED
		);
	}

	async isInfoHashInClient(infoHash: string): Promise<boolean> {
		const responseText = await this.request(
			"/torrents/properties",
			`hash=${infoHash}`,
			X_WWW_FORM_URLENCODED
		);
		try {
			const properties = JSON.parse(responseText);
			return properties && typeof properties === "object";
		} catch (e) {
			return false;
		}
	}

	async getTorrentConfiguration(searchee: Searchee): Promise<{
		save_path: string;
		isComplete: boolean;
		autoTMM: boolean;
		category: string;
	}> {
		const { dataDirs, dataMode } = getRuntimeConfig();
		if (searchee.path) {
			const save_path: string = dirname(searchee.path);
			const isComplete: boolean = true;
			const autoTMM: boolean = false;
			const category: string = " ";
			return {save_path, isComplete, autoTMM, category}
		}
		const responseText = await this.request(
			"/torrents/info",
			`hashes=${searchee.infoHash}`,
			X_WWW_FORM_URLENCODED
		);
		const searchResult = JSON.parse(responseText).find(
			(e) => e.hash === searchee.infoHash
		) as TorrentInfo;
		if (searchResult === undefined) {
			throw new Error(
				"Failed to retrieve data dir; torrent not found in client"
			);
		}

		const { progress, save_path, auto_tmm, category } = searchResult;
		return {
			save_path,
			isComplete: progress === 1,
			autoTMM: auto_tmm,
			category,
		};
	}

	async correct_path(newTorrent: Metafile, searchee: Searchee, save_path: string): Promise<string> {
		const { dataMode } = getRuntimeConfig();
		// Path being a directory implies we got a perfect match at the directory level.
		// Thus we don't need to rename since it's a perfect match.
		if (!statSync(searchee.path).isDirectory()) {
			if (newTorrent.files[0].path.split(sep).length > 1) {
				return dirname(save_path);
			}
		}
		return save_path;
	}

	async isSubfolderContentLayout(searchee: Searchee): Promise<boolean> {
		const { dataDirs } = getRuntimeConfig();
		if (dataDirs.length > 0) {
			return statSync(searchee.path).isDirectory();
		}
		const response = await this.request(
			"/torrents/files",
			`hash=${searchee.infoHash}`,
			X_WWW_FORM_URLENCODED
		);

		const files: TorrentFiles[] = JSON.parse(response);
		const [{ name }] = files;
		return files.length === 1 && name !== posix.basename(name);
	}

	async inject(
		newTorrent: Metafile,
		searchee: Searchee
	): Promise<InjectionResult> {
		const { dataDirs, duplicateCategories } = getRuntimeConfig();
		if (await this.isInfoHashInClient(newTorrent.infoHash)) {
			return InjectionResult.ALREADY_EXISTS;
		}
		const buf = parseTorrent.toTorrentFile(newTorrent);
		const filename = `${newTorrent.name}.cross-seed.torrent`;
		const tempFilepath = join(tmpdir(), filename);
		await writeFile(tempFilepath, buf, { mode: 0o644 });
		try {
			const { save_path, isComplete, autoTMM, category } =
				await this.getTorrentConfiguration(searchee);

			// As there's no way to know here if we matched perfectly or with a renamed top directory
			// without the MATCH_EXCEPT_PARENT_DIR result, we have to manually check the new torrent's
			// structure to see which directory is the correct parent.
			const corrected_save_path = await this.correct_path(newTorrent, searchee, save_path)
			
			const newCategoryName = searchee.infoHash ? 
			(duplicateCategories
				? await this.setUpCrossSeedCategory(category)
				: category) 
				: "cross-seed-data";

			if (!isComplete) return InjectionResult.TORRENT_NOT_COMPLETE;

			const shouldManuallyEnforceContentLayout =
				isSingleFileTorrent(newTorrent) &&
				(await this.isSubfolderContentLayout(searchee));

			const file = await fileFrom(
				tempFilepath,
				"application/x-bittorrent"
			);
			const formData = new FormData();
			formData.append("torrents", file, filename);
			formData.append("tags", "cross-seed");
			formData.append("category", newCategoryName);
			if (autoTMM) {
				formData.append("autoTMM", "true");
			} else {
				formData.append("autoTMM", "false");
				formData.append("savepath", corrected_save_path);
			}
			if (shouldManuallyEnforceContentLayout) {
				formData.append("contentLayout", "Subfolder");
				formData.append("skip_checking", "false");
				formData.append("paused", "true");
			} else {
				formData.append("skip_checking", "true");
				formData.append("paused", "false");
			}

			// for some reason the parser parses the last kv pair incorrectly
			// it concats the value and the sentinel
			formData.append("foo", "bar");

			await this.request("/torrents/add", formData);

			if (shouldManuallyEnforceContentLayout) {
				await this.request(
					"/torrents/recheck",
					`hashes=${newTorrent.infoHash}`,
					X_WWW_FORM_URLENCODED
				);
				await this.request(
					"/torrents/resume",
					`hashes=${newTorrent.infoHash}`,
					X_WWW_FORM_URLENCODED
				);
			}

			unlink(tempFilepath).catch((error) => {
				logger.debug(error);
			});

			return InjectionResult.SUCCESS;
		} catch (e) {
			logger.debug({
				label: Label.QBITTORRENT,
				message: `injection failed: ${e.message}`,
			});
			return InjectionResult.FAILURE;
		}
	}
	async rename(
		torrent: Metafile,
		searchee: Searchee,
		tracker: string): Promise<RenameResult> {
			try {
				const fileFormData = new FormData();
				const file = torrent.files[0];
				const isNestedFile = file.path.split(sep).length > 1;
				fileFormData.append("hash", torrent.infoHash);
				const oldFilePath = file.path;
				fileFormData.append("oldPath", oldFilePath);
				const newFilePath = isNestedFile ?
					join(dirname(file.path), basename(searchee.path)) :
					basename(searchee.path);
				fileFormData.append("newPath", newFilePath);
				fileFormData.append("foo", "bar");
				await this.request("/torrents/renameFile", fileFormData); 
				if (isNestedFile) {
					const folderFormData = new FormData();
					const newFolderPath = basename(dirname(searchee.path));
					const oldFolderPath = file.path.split(sep)[0];
					folderFormData.append("hash", torrent.infoHash);
					folderFormData.append("oldPath", oldFolderPath);
					folderFormData.append("newPath", newFolderPath);
					folderFormData.append("foo", "bar");
					await this.request("/torrents/renameFolder", folderFormData);
				}
				await this.request(               // for some reason, this pause, recheck, resume loop is required to get the torrents 
					"/torrents/pause",            // to not just say "missing files." I hope there's a workaround for this,
					`hashes=${torrent.infoHash}`, // because the recheck time would be immense when scanned on a large library.
					X_WWW_FORM_URLENCODED
				);
				await this.request(
					"/torrents/recheck", 
					`hashes=${torrent.infoHash}`,
					X_WWW_FORM_URLENCODED);
				//await this.request(
				//	"/torrents/resume", 
				//	`hashes=${torrent.infoHash}`,
				//	X_WWW_FORM_URLENCODED);
				return RenameResult.SUCCESS;
			} catch (e) {
				logger.debug({
					label: Label.QBITTORRENT,
					message: `Rename failed: ${e.message}`,
				});
				return RenameResult.FAILURE;
			}
		}
}

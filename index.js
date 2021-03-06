// API
const EventEmitter = require('events');
const emitter = new EventEmitter();
const express = require(`express`);
const app = express();
const expressWS = require('express-ws')(app);
const GlobalOffensive = require('globaloffensive');
const fetch = require('node-fetch');
const request = require('request');
const cheerio = require('cheerio');

const { DB, singleDB } = require("./db");

app.use(express.json({ extended: true }));

// Add headers
app.use(function (request, response, next) {
	response.setHeader('Access-Control-Allow-Origin', '*');
	response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
	response.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type');
	response.setHeader('Access-Control-Allow-Credentials', true);
	next();
});

require('dotenv').config();

// STEAM
const SteamUser = require(`steam-user`);
const SteamCommunity = require(`steamcommunity`);
const TradeManager = require(`steam-tradeoffer-manager`);
const steamTOTP = require(`steam-totp`);
const { SteamID } = require('steamcommunity');

const steam = new SteamUser();
const CSGO = new GlobalOffensive(steam);

const steamOptions = { 
	accountName: process.env.STEAM_ACCOUNT, 
	password: process.env.STEAM_PASSWORD, 
	twoFactorCode: steamTOTP.getAuthCode(process.env.STEAM_SHARED_SECRET)
};
const managerOptions = { steam, domain: `localhost`, language: `ru` };

const manager = new TradeManager(managerOptions);
const community = new SteamCommunity();

// misc func

const exitWithError = (error) => {
	console.log(error);
	process.exit(1);
};

// listeners

steam.on(`loggedOn`, () => {
	console.log(`Logged into Steam`);
	steam.setPersona(1);
	steam.gamesPlayed([730]);
});

steam.on(`webSession`, (sessionID, cookies) => {
	manager.setCookies(cookies, (error) => {
		if (error) exitWithError(error);
		console.log(`Got API key: ` + manager.apiKey);
	});
	community.setCookies(cookies);
	community.startConfirmationChecker(20000, process.env.STEAM_IDENTITY_SECRET);
});

manager.on(`newOffer`, (offer) => {
	console.log(`New offer #` + offer.id + ` from ` + offer.partner.getSteam3RenderedID());
	offer.accept((error, status) => {
		if (error) return exitWithError(error);
		console.log(`Offer accepted: ` + status);
		if (status !== `pending`) return false;
		community.acceptConfirmationForObject(process.env.STEAM_IDENTITY_SECRET, offer.id, (error) => {
			if (error) return exitWithError(error);
			console.log(`Trade offer ` + offer.id + ` confirmed`);
		});
	});
});

manager.on(`receivedOfferChanged`, (offer, oldState) => {
	console.log(`Offer #${offer.id} changed: ${TradeManager.ETradeOfferState[oldState]} -> ${TradeManager.ETradeOfferState[offer.state]}`);
	if (offer.state != TradeManager.ETradeOfferState.Accepted) return false;
	offer.getExchangeDetails((error, status, tradeInitTime, receivedItems, sentItems) => {
		if (error) return exitWithError(error);
		const newReceivedItems = receivedItems.map(item => item.new_assetid);
		const newSentItems = sentItems.map(item => item.new_assetid);
		console.log(`Received items ${newReceivedItems.join(',')} Sent Items ${newSentItems.join(',')} - status ${TradeManager.ETradeStatus[status]}`)
	});
});

manager.on(`sentOfferChanged`, (offer) => {
	const type = (offer.itemsToGive.length > 0) ? `skins` : `exchange`;
	const data = { offer, type };
	// if (offer.state === 3) updateUserBalance(offer.itemsToReceive, `sell`);
	emitter.emit(`socketMessage`, JSON.stringify(data));
});

manager.on(`sentOfferCanceled`, (offer, reason) => {
	console.log(`sentOfferCanceled`);
});

manager.on(`sentPendingOfferCanceled`, (offer) => {
	console.log(`sentPendingOfferCanceled`);
});

manager.on(`realTimeTradeConfirmationRequired`, (offer) => {
	console.log(`realTimeTradeConfirmationRequired`);
});

manager.on(`realTimeTradeCompleted`, (offer) => {
	console.log(`realTimeTradeCompleted`);
});

steam.on(`newItems`, (count) => {
	console.log(`newItems`, count);
});

CSGO.on(`connectedToGC`, () => {
	console.log(`connectedToGC`);
});

// UPDATE ITEM PRICE EVERY 1 sec FROM market.csgo.com

let priceData = {};
const requestPrice = async () => {
	try {
		const response = await fetch(`https://market.csgo.com/api/v2/prices/RUB.json`);
		priceData = await response.json();
	} catch (error) {
		console.log(error);
	}
};
requestPrice();
setInterval(requestPrice, 60 * 1000);

// steam login

steam.logOn(steamOptions);

// MISC functions

const getSteamID = (tradeLink) => {
	const partnerID = new URL(tradeLink).searchParams.get(`partner`);
	const steamID = SteamID.fromIndividualAccountID(partnerID).getSteamID64();
	return steamID;
};

// API functions

// const updateUserBalance = async (offerItems, action, soc_id) => {
// 	const queryItems = offerItems.map((item) => item.market_hash_name);
// 	const query = `SELECT * FROM market_items WHERE market_hash_name IN (?)`;
// 	const response = await DB(query, [ queryItems ]);
// 	switch (action) {
// 		case 'exchange':
// 			console.log(`exchange`);
// 			const value = response.reduce((sum, { market_price_ru }) => sum + Number(market_price_ru), 0);
// 			const balanceQuery = `UPDATE windrop.cms_users SET balance = balance + ? WHERE soc_id = ?`;
// 			const balanceResponse = await DB(balanceQuery, [ value, soc_id ]);
// 			console.log(balanceResponse);
// 			break;
// 		case 'skins':
// 			console.log(`skins`);
// 			const value = response.reduce((sum, { price_ru }) => sum + Number(price_ru), 0);
// 			const balanceQuery = `UPDATE windrop.cms_users SET balance = balance - ? WHERE soc_id = ?`;
// 			const balanceResponse = await DB(balanceQuery, [ value, soc_id ]);
// 			console.log(balanceResponse);
// 			break;
// 	}
// };

const createSellOffer = ({ tradeLink, items }) => {
	return new Promise((resolve) => {
		const offer = manager.createOffer(tradeLink);
		offer.loadPartnerInventory(730, 2, (error, inventory) => {
			console.log(inventory);
			if (error) resolve(error);
			inventory.forEach((item) => {
				if (!items.includes(item.assetid)) return false;
				offer.addTheirItem(item);
			});
			offer.send((error, status) => {
				if (error) resolve(error);
				const data = { offer, status };
				resolve(data);
			});
		});
	});
};

const createBuyOffer = ({ steamID, items }) => {
	return new Promise((resolve) => {
		const offer = manager.createOffer(steamID);
		manager.loadInventory(730, 2, true, (error, inventory) => {
			if (error) resolve(error);
			inventory.forEach((item) => {
				if (!items.includes(item.assetid)) return false;
				offer.addMyItem(item);
			});
			offer.send((error, status) => {
				if (error) resolve(error);
				const data = { offer, status };
				resolve(data);
			});
		});
	});
};

const requestUserInventory = ({ steamID }) => {
	return new Promise((resolve) => {
		community.getUserInventoryContents(steamID, 730, 2, true, `russian`, (error, inventory) => {
			if (error) return resolve(error);
			resolve(inventory);
		});
	});
};

const requestSteamPrice = ({ marketName }) => {
	return new Promise((resolve) => {
		community.getMarketItem(730, marketName, 5, (error, market) => {
			if (error) resolve(error);
			resolve(market);
		});
	});
};

const requestItemDetail = ({ gameLink }) => {
	return new Promise((resolve) => {
		CSGO.inspectItem(gameLink, (error, market) => {
			if (error) resolve(error);
			resolve({ market });
		});
	});
};

const collectItemsData = (data) => {
	return new Promise(async (resolve) => {
		try {
			const queryItems = data.map((item) => item.market_hash_name);
			const query = `SELECT * FROM market_items WHERE market_hash_name IN (?) && rarity IS NOT NULL && rarity_num >= 2`;
			const response = await DB(query, [ queryItems ]);
			const items = response.map((item) => {
				const searchItem = data.filter((userItem) => userItem.market_hash_name === item.market_hash_name);
				item.assetid = searchItem[0].assetid;
				return item;
			});
			resolve(items);
		} catch (error) {
			console.log(error);
			resolve([]);
		}
	});
};

// EXPRESS

// http://localhost:8888/api/inventory/76561198055031516
app.get(`/api/inventory/:steamID`, async (request, response) => {
	try {
		const { params: { steamID }} = request;
		const data = await requestUserInventory({ steamID });
		response.json(data);
	} catch (error) {
		console.log(error);
		response.json({});
	}
});

// http://localhost:8888/api/skins
app.get(`/api/skins`, async (request, response) => {
	try {
		const steamID = process.env.STEAM_BOT_ID;
		const data = await requestUserInventory({ steamID });
		response.json(data);
	} catch (error) {
		console.log(error);
		response.json({});
	}
});

// http://localhost:8888/api/inventory
app.post(`/api/inventory`, express.json({type: '*/*'}), async (request, response) => {
	try {
		const { body: { tradeLink }} = request;
		const data = await requestUserInventory({ steamID: getSteamID(tradeLink) });
		const items = await collectItemsData(data);
		// console.log(items);
		response.json(items);
	} catch (error) {
		console.log(error);
		response.json({});
	}
});

// http://localhost:8888/api/item/Galil%20AR%20%7C%20Signal%20(Field-Tested)/price
app.get(`/api/item/:marketName/price`, async (request, response) => {
	try {
		const { params: { marketName }} = request;
		const data = await requestSteamPrice({ marketName });
		response.json(data);
	} catch (error) {
		console.log(error);
		response.json({});
	}
});

// http://localhost:8888/api/item/detail
app.post(`/api/item/:gameLink/detail`, express.json({type: '*/*'}), async (request, response) => {
	try {
		const { body: { gameLink }} = request;
		const data = await requestItemDetail({ gameLink });
		response.json(data);
	} catch (error) {
		console.log(error);
		response.json({});
	}
});

// http://localhost:8888/api/trade/sell/
// body - steamID (ID or Trade link) | items - array of items assetid
app.post(`/api/trade/sell`, express.json({type: '*/*'}), async (request, response) => {
	try {
		const { body: { tradeLink, items }} = request;
		console.log(tradeLink, items);
		const data = await createSellOffer({ tradeLink, items });
		response.json(data);
	} catch (error) {
		console.log(error);
		response.json({});
	}
});

// http://localhost:8888/api/trade/buy/
// body - steamID (ID or Trade link) | items - array of items assetid
app.post(`/api/trade/buy`, express.json({type: '*/*'}), async (request, response) => {
	try {
		const { body: { steamID, items }} = request;
		const data = await createBuyOffer({ steamID, items });
		response.json(data);
	} catch (error) {
		console.log(error);
		response.json({});
	}
});

// http://localhost:8888/api/price
app.get(`/api/price`, async (request, response) => {
	try {
		response.json(priceData);
	} catch (error) {
		console.log(error);
		response.json({});
	}
});

app.get(`/api/market`, async (request, response) => {
	const query = `
		SELECT * FROM market_items 
		WHERE 
			market_price_ru <= price_ru && market_volume > 0 && 
			rarity IS NOT NULL && rarity_num IS NOT NULL 
		ORDER BY sold_24h DESC;
	`;
	const items = await DB(query);
	response.json(items);
});

// sockets link to 
app.ws(`/api/messages`, (WS, request) => {
	emitter.on(`socketMessage`, (message) => {
		WS.send(message);
	});
});

// update bot inventory volume property

const updateBotInventory = () => {
	console.log(`start bot inventory requesting`);
	setInterval(async () => {
		try {
			const steamID = process.env.STEAM_BOT_ID;
			const data = await requestUserInventory({ steamID });
			if (!data.length) return console.log(`inventory request error`);
			const items = data.map((item) => item.market_hash_name);
			const query = `UPDATE market_items SET bot_volume = 0`;
			await DB(query);
			for (const item of items) {
				const updateData = { bot_volume: 1 };
				const query = `UPDATE market_items SET ? WHERE market_hash_name = ?`;
				await DB(query, [ updateData, item ]);
			}
		} catch (error) {
			console.log(error);
		}
	}, 60000);
};

updateBotInventory();

app.listen(process.env.PORT);
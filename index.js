// API
const EventEmitter = require('events');
const emitter = new EventEmitter();
const express = require(`express`);
const app = express();
const expressWS = require('express-ws')(app);
const GlobalOffensive = require('globaloffensive');
const fetch = require('node-fetch');
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

const formatItemData = ({ item, market }) => {
	if (!item) return false;
	const { 
		assetid, name, name_color, type, market_name, market_hash_name, 
		marketable, tags, icon_url, icon_url_large, market_actions
	} = item;
	const { 0: { price } = { price: null }} = market;
	return {
		assetid, name, name_color, type, market_name, market_hash_name, 
		marketable, tags, price, market_actions, 
		icons: { 
			thumb: (icon_url) ? process.env.STEAM_CDN + icon_url : null,
			image: (icon_url_large) ? process.env.STEAM_CDN + icon_url_large : null,
		}
	};
};

const getSteamID = (tradeLink) => {
	const partnerID = new URL(tradeLink).searchParams.get(`partner`);
	const steamID = SteamID.fromIndividualAccountID(partnerID).getSteamID64();
	return steamID;
};

// API functions

const createSellOffer = ({ tradeLink, items }) => {
	console.log(items);
	return new Promise((resolve) => {
		const offer = manager.createOffer(tradeLink);
		offer.loadPartnerInventory(730, 2, (error, inventory) => {
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
			const items = inventory.map((item) => {
				if (!item.assetid) return false;
				const market = priceData.items.filter(({ market_hash_name }) => item.market_hash_name === market_hash_name );
				return formatItemData({ item, market });
			});
			resolve(items);
		});
	});
};

const requestSteamPrice = ({ marketName }) => {
	return new Promise((resolve) => {
		community.getMarketItem(730, marketName, (error, market) => {
			if (error) resolve(error);
			const price = (market) ? market.lowestPrice / 100 : null;
			resolve({ price });
		});
	});
};

const requestItemDetail = ({ gameLink }) => {
	return new Promise((resolve) => {
		CSGO.inspectItem(gameLink, (error, market) => {
			if (error) resolve(error);
			console.log(market);
			resolve({ market });
		});
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
		response.json(data);
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

// http://localhost:8888/api/trade/buy/
// body - steamID (ID or Trade link) | items - array of items assetid
app.get(`/api/trade/buy`, async (request, response) => {
	try {
		const { body: { steamID, items }} = request;
		const data = await createSellOffer({ steamID, items });
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

// sockets link to 
app.ws(`/api/messages`, (WS, request) => {
	emitter.on(`socketMessage`, (message) => {
		WS.send(message);
	});
});

app.listen(process.env.PORT);
"use strict"
const Http = require("http");
const Url = require("url");
const Path = require("path");
const Browser = require("zombie");
const NodeCache = require("node-cache");

const defaultPort = 80;
const defaultSkipResource = ["analytics", "mc.yandex.ru", "raygun", "pingdom", "statuscake"];

let port = process.env.PORT || defaultPort;
if (process.argv.length > 2) {
	port = Number.parseInt(process.argv[2]);
	if (isNaN(port)) {
		console.error("Third arguments should be port number");
		process.exit(1);
	}
}

const apiKey = process.env.PrerenderApiKey;

// configure all browsers
Browser.silent = true;
Browser.waitDuration = "30s";
Browser.userAgent = "Mozilla/5.0 Chrome/10.0.613.0 Safari/534.15 PrerenderBot";
const pipelineDefault = Browser.Pipeline._default;
for (let i=0; i<pipelineDefault.length; i++) {
	// remove redirection
	if (pipelineDefault[i].name == "handleRedirect") {
		pipelineDefault.splice(i, 1);
		break;
	}
}

// configure resources cache
const cache = new NodeCache({ stdTTL: 300 });
const cachedExtensions = [".js", ".css"];

// start HTTP server
console.log("Starting server at port", port)
const server = Http.createServer(handleServer).listen(port);
console.log("Server started at port", port);

// server handler
function handleServer(request, response) {
	// check for HTTP method
	if (request.method !== "GET") {
		responseWithError(response, 501, "Method not supported");
		return;
	}
	
	// check api key
	if (apiKey && request.header["api-key"] != apiKey) {
		responseWithError(response, 400, "Invalid Api-Key");
		return;
	}
	
	// get prerender host
	const baseUrl = request.headers["base-url"];
	if (!baseUrl) {
		responseWithError(response, 400, "Base-Url is not specified");
		return;
	}
	
	// ignore request to resources with extensions
	const url = Url.parse(Url.resolve(baseUrl, request.url));
	if (Path.extname(url.pathname) !== "") {
		responseWithError(response, 403, "Static resources not allowed");
		return;
	}
	
	// create browser
	const browser = new Browser();
	browser.pipeline.addHandler(function(browser, request) {
		return handleBrowserRequest(request, defaultSkipResource);
	});
	//browser.debug();
	
	// visit page
	const start = Date.now();
	console.log(request.method, url.href);
	browser.visit(url.href)
		.then(function () {
			const status = handleBrowserVisit(url, browser, response);
			console.log("%d %s, elapsed %dms", status, url.href, Date.now() - start);
			browser.destroy();
		})
		.catch(function (error) {
			response.writeHead(500);
			response.write(error.toString());
			if (error.stack)
				response.write(error.stack);
			response.end();
			console.error("ERROR %s, elapsed %dms", url.href, Date.now() - start);
			browser.destroy();
		});
}

// browser visit handler
function handleBrowserVisit(url, browser, response) {
	let status = browser.status;
	const headers = browser.response.headers;
	
	const resultUrl = Url.parse(browser.url);
	resultUrl.hostAndPath = getHostAndPath(resultUrl);
	url.hostAndPath = getHostAndPath(url);
	
	// handle redirects
	if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
		response.writeHead(status, browser.response.statusText, {
			"Location": headers.get("Location")
		});
	}
	// handle location change
	else if (resultUrl.hostAndPath !== url.hostAndPath) {
		let redirectUrl = browser.url;
		const baseUrl = url.href.substr(0, url.href.length - url.path.length);
		if (redirectUrl.startsWith(baseUrl))
			redirectUrl = redirectUrl.substr(baseUrl.length);
		
		response.writeHead(302, {
			"Location": redirectUrl
		});
		status = 302;
	}
	// handle other
	else {
		response.writeHead(status, browser.response.statusText, {
			"Content-Type": headers.get("Content-Type")
		});
		response.write(browser.html());
	}
	response.end();
	return status;
}

// skips resources that contains specified strings in the URL and provides caching
function handleBrowserRequest(request, skipResources) {
	// get from cache
	const cacheResult = cache.get(request.url);
	if (cacheResult !== undefined) {
		//console.log("  Cache", request.url);
		return cacheResult;
	}
	
	// skip if required
	let response = null;
	for (var res of skipResources) {
		if (request.url.indexOf(res) != -1) {
			response = new Browser.Response("", { url: request.url, status: 404 });
			break;
		}
	}	
	
	// save to cache
	const url = Url.parse(request.url);
	const ext = Path.extname(url.pathname).toLowerCase();
	if (cachedExtensions.indexOf(ext) != -1)
		cache.set(request.url, response);

	// return
	//console.log(response ? "  Skipped" : "  Loading", request.url);
	return response;
}

// writes error of specified code to the response
function responseWithError(response, code, message) {
	response.writeHead(code, message);
	response.end(message);
}

function getHostAndPath(url) {
	return url.search
		? url.href.substr(0, url.href.length - url.search.length)
		: url.href;
}
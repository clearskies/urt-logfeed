var server = require('http').createServer(handler);
var io = require('socket.io')(server);
var fs = require('fs');
var Tail = require('tail').Tail;

require('./config');
require('./events');

tail = new Tail(config.logPath);

server.listen(3000);

function retFile(filename) {
	try {
		return fs.readFileSync(__dirname + "/" + filename);
	} catch (e) {
		return null;
	}
}

function handler (req, res) {
	if (req.url == "/formatters.js") {
		var file = retFile("client/formatters.js");
	} else if (req.url == "/filter-groups.js") {
		var file = retFile("client/filter-groups.js");
	} else {
		var file = retFile("client/index.html");
	}

	if (!file) {
		res.writeHead(500);
		res.end("Couldn't load " + req.url + ", sorry.");
	} else {
		res.writeHead(200);
		res.end(file);
	}	
}

var gameVars = null;
var clients = {};
var pendingEvents = [];

function cidToName(cid) {
	if (cid in clients && "name" in clients[cid]) {
		return clients[cid].name;
	}
	return false;
}

function mergeObj(obj1, obj2) { // Merges obj2's attributes onto obj1
	if (obj1 == undefined) {
		return;
	}
	for (var attr in obj2) {
		obj1[attr] = obj2[attr];
	}
}	

function ensureClientInit(cid) {
	if (clients[cid] == undefined) {
		clients[cid] = {};
	}
	return;
}

function parseLine(line) {
	var lineRE = /^\s*(\d+:\d+)\s?(.+)$/;
	var lineMatch = lineRE.exec(line);
	if (!lineMatch) {
		return null;
	}
	var time = lineMatch[1];
	line = lineMatch[2];
	if (line == "Pop!") {
		var event = {type: "BombExplode", time: time, subject: {id: -1, name: null}, object: {id: -1, name: null}, data: {}};
		return event;
	}
	var eventRE = /(.+?): ?(.*)/;
	var bombRE = /Bomb (?:was|has been) (.+?) by (\d+)/;
	var match = eventRE.exec(line);
	var bombMatch = bombRE.exec(line);
	if (match) {
		var eventType = match[1];
		var rawEventData = match[2];
	} else if (bombMatch) {
		var eventType = bombMatch[1];
		var rawEventData = bombMatch[2];
	} else {
		return null;
	}
	if (eventType + "Parser" in eventParsers) {
		event = eventParsers[eventType + "Parser"](rawEventData);

		if (event == null) {
			return null;
		}

		if (event.subject.id > -1) {
			ensureClientInit(event.subject.id);
		}

		if (event.object.id > -1) {
			ensureClientInit(event.object.id);
		}

		if (event.type == "MapChange" || event.type == "InitRound") {
			if (gameVars == null) {
				gameVars = event.data;
			} else {
				mergeObj(gameVars, event.data);
			}
			if (event.type == "MapChange") {
				event.data = {map: event.data.mapname};
			}
		} else if (event.type == "ClientConnect") {
			pendingEvents.push(event);
			return null;
		} else if (event.type == "ClientRename") {
			var origName = cidToName(event.subject.id);
			if (event.subject.name != origName) {
				mergeObj(clients[event.subject.id], event.data);
				event.data = {name: event.subject.name};
				if (origName) {
					event.subject.name = origName;
				} else {
					event.subject.name = null;
				}
			} else {
				mergeObj(clients[event.subject.id], event.data);
				return null;
			}
			var last = pendingEvents.pop();
			if (last != undefined) {
				if (last.type == "ClientConnect") {
					last.subject.name = event.data.name;
					event = last;
				} else {
					pendingEvents.push(last);
				}
			}
		} else if (event.type == "ClientTeamChange") {
			if ("team" in clients[event.subject.id] && clients[event.subject.id].team == event.data.team) {
				return null;
			}
			mergeObj(clients[event.subject.id], {team: event.data.team});
		} else if (event.type == "Kill") {
			if (event.data.weapon.name == "CHANGE TEAM") {
				return null;
			}
			if (event.data.type == 0 &&
				"team" in clients[event.subject.id] &&
				"team" in clients[event.object.id]) {
				if (clients[event.subject.id].team == clients[event.object.id].team && clients[event.subject.id].team != "Green") {
					event.data.type = 1;
				}
			}
		} else if (event.type == "FlagDrop" || event.type == "FlagPickup" || event.type == "FlagCapture") {
			var opposite = {"Red": "Blue", "Blue": "Red"};
			if (clients[event.subject.id].team == undefined) {
				clients[event.subject.id].team = opposite[event.data.flag];
			}
		} else if (event.type == "FlagReturn") {
			 if (clients[event.subject.id].team == undefined) {
				 clients[event.subject.id].team = event.data.flag;
			}
		} else if (event.type == "BombDrop" || event.type == "BombPickup" || event.type == "BombPlant") {
			clients[event.subject.id].team = "Red";
		} else if (event.type == "BombDefuse") {
			clients[event.subject.id].team = "Blue";
		}
/*
		if (event.type == "ClientTeamChange") {
			if (!clients[event.subject.id].began) {
				return null;
			}
		}
*/
		if (event.subject.name != null) {
			mergeObj(clients[event.subject.id], {name: event.subject.name});
		}

		if (event.object.name != null) {
			mergeObj(clients[event.object.id], {name: event.object.name});
		}
	
		var name;

		if (event.subject.name == null && event.type != "ClientRename") {
			name = cidToName(event.subject.id);
			if (name) {
				event.subject.name = name;
			}
		}

		if (event.object.name == null) {
			name = cidToName(event.object.id);
			if (name) {
				event.object.name = name;
			}
		}

		if (event.type == "ClientDisconnect") {
			delete clients[event.subject.id];
		}

		event.time = time;
		return event;
	} else {
		return null;
	}
}

var connections = {};

io.on('connection', function(socket) {
	var availableEvents = [];
	for (var e in config.exposeEvents) {
		if (config.exposeEvents[e]) {
			availableEvents.push(e);
		}
	}
	socket.emit("exposedEvents", availableEvents);
	connections[socket.id] = {conn: socket, filter: {}, paused: false};
	for (var i = 0; i < availableEvents.length; i++) {
		connections[socket.id].filter[availableEvents[i]] = true;
	}
	socket.on("hideEvent", function(event) {
		if (event in connections[socket.id].filter) {
			connections[socket.id].filter[event] = false;
		}
	});
	socket.on("showEvent", function(event) {
		if (event in connections[socket.id].filter) {
			connections[socket.id].filter[event] = true;
		}
	});
	socket.on("pause", function() {
		connections[socket.id].paused = true;
	});
	socket.on("unpause", function() {
		connections[socket.id].paused = false;
	});
	socket.on('disconnect', function() {
		delete connections[socket.id];
	});
});


tail.on("line", function(line) {
	var event = parseLine(line);
	var sentTo = 0;
	if (!!event) {
		if (config.exposeEvents[event.type]) {
			sentTo = 0;
			for (conn in connections) {
				if (!connections[conn].paused && connections[conn].filter[event.type]) {
					connections[conn].conn.emit("event", event);
					sentTo++;
				}
			}
			console.log("Event sent: " + event.type + ", to " + sentTo + " clients.");
		}
	}
});


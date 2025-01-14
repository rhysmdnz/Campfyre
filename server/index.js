function addslashes(str) {
	return (str + '').replace(/[\\"']/g, '\\$&').replace(/\u0000/g, '\\0');
}

var app = require('express')();
var http = require('http').Server(app);
var ws = require('socket.io')(http);
var format = require('@scaleleap/pg-format');
var crypto = require('crypto');
const { Client } = require('pg')
const con = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});
con.connect();

var salt = process.env['CAMPFYRE_SALT'];
var adminId = process.env['CAMPFYRE_ADMIN_ID'];

// This is all horrific code, lets make it more horrific with some push notification stuff
// campfyreId => socket
const users = {};

function getPosts(ip, size, search, startingPost, loadBottom, socket, reverse, user, batch) {
	//Get the posts from the database
	if (search) {
		search = addslashes(search);
		var extraChar = "";
		if (search.substr(0, 1) == "#") {
			search = search.substr(1, search.length);
			extraChar = "#";
		}
		var query = "SELECT * FROM posts WHERE LOWER(\"post\") ~ '"+extraChar+"[[:<:]]"+search+"[[:>:]]' ORDER BY id DESC OFFSET "+format.literal(startingPost)+" LIMIT 50;";
	}
	else {
		if (user) {
			var query = "SELECT * FROM posts WHERE \"post\" NOT LIKE '%#bonfyre%' AND \"hash_id\" = "+format.literal(user)+" ORDER BY id DESC OFFSET "+format.literal(startingPost)+" LIMIT 50;";
		}
		else {
			var query = "SELECT * FROM posts WHERE \"post\" NOT LIKE '%#bonfyre%' ORDER BY id DESC OFFSET "+format.literal(startingPost)+" LIMIT 50;";
		}
	}

	con.query(query, function(e, posts) {
		if (e) throw e;
		
		//Send the posts to the user
		for (var i = 0; i < posts.rows.length; ++i) {
			var post = posts.rows[i];
			con.query('SELECT * FROM comments WHERE \"parent\" = '+post.id+';', (function(i, post, e, comments) {
				if (e) throw e;

				if (comments.rows.length === 1) {
					post.commentNum = comments.rows.length+' comment';
				}
				else {
					post.commentNum = comments.rows.length+' comments';
				}

				for (var j = 0; j < comments.rows.length; ++j) {
					comments.rows[j].ip = 'http://robohash.org/'+hash(salt+comments.rows[j].ip)+'.png?set=set4&size='+size;
				}

				post.comments = comments.rows;

				post.ip = 'http://robohash.org/'+post.hash_id+'.png?set=set4&size='+size;

				if (loadBottom) {
					post.loadBottom = true;
				}
				else {
					post.loadBottom = false;
				}

				//Are we subscribed to this post?
				con.query("SELECT \"notifylist\" FROM \"posts\" WHERE \"id\" = '"+addslashes(post.id)+"';", function(e, results) {
					if (e) throw e;

					var notifylist = results.rows[0].notifylist;
					if (notifylist) {
						notifylist = JSON.parse(notifylist);
						if (notifylist.IPs.indexOf(ip) <= -1) {
							post.subscribed = false;
						}
						else {
							post.subscribed = true;
						}
					}
					else {
						post.subscribed = false;
					}

					delete post.notifylist;
					delete post.voters;
					socket.emit('new post', JSON.stringify(post));
				});

			}).bind(this, i, post));
		}
	});
}

function stoke(id, ip, socket) {
	//Check the user hasn't already voted
	con.query("SELECT \"voters\" FROM posts WHERE \"id\" = '"+id+"'", function(e, voters) {
		if (e) throw e;

		if (voters.rows[0].voters){
			voters = voters.rows[0].voters.split(',');
		}
		else {
			voters = [];
		}
		if (voters.indexOf(ip) == -1) {
			//Stoke the post
			con.query("UPDATE \"posts\" SET \"voters\" = CASE WHEN voters = NULL THEN '"+ip+"' ELSE CONCAT(\"voters\", ',"+ip+"') END WHERE \"id\" = '"+format.literal(id)+"';", function (e) {
				if (e) throw e;
				con.query("UPDATE \"posts\" SET \"score\" = \"score\" + 1 WHERE \"id\" = '"+format.literal(id)+"';");
				socket.emit('success message', JSON.stringify({title: 'Post stoked', body: ''}));

				//Tell everyone about the stoke
				con.query("SELECT \"score\" FROM posts WHERE \"id\" = '"+format.literal(id)+"';", function (e, posts) {
					if (e) throw e;

					ws.emit('post stoked', JSON.stringify({
						id: format.literal(id),
						score: posts.rows[0].score
					}));
				});
			});
		}
		else {
			//Don't stoke and return an error
			socket.emit('error message', JSON.stringify({title: 'Post not stoked', body: 'You can only stoke once'}));
		}
	});
}

function submitPost(text, attachment, catcher, ip, isNsfw, socket) {
	//Get teh [sic] time
	var time = Math.floor(Date.now() / 1000) - 5;
	
	//Sort out other vars
	text = text.replace(/(<([^>]+)>)/ig,"");
	safeText = format.literal(text);
	attachment = attachment.replace(/(<([^>]+)>)/ig,"");
	if (attachment) {
		attachment = format.literal(attachment);
	}
	else {
		attachment = format.literal('n/a')
	}
	var spamming = false;

	//Catch spammers
	con.query("SELECT \"ip\" FROM posts ORDER BY \"id\" DESC LIMIT 3", function (e, results) {
		if (e) throw e;

		// if (results[0].ip == ip && results[1].ip == ip && results[2].ip == ip) {
		// 	spamming = true;
		// }
		// else if (catcher.length > 0) {
		// 	spamming = true;
		// }

		if (catcher.length > 0) {
			spamming = true;
		}

		//Submit the post
		if (text && ip && attachment) {
			if (text.length <= 256 && !spamming) {
				var profanity = text.match(/(cum|jizz|pussy|penis|vagina|cock|dick|cunt|porn|p0rn|tits|tities|boob\S*|sex|ballsack|twat\S*)/im);
				if (profanity != null || isNsfw){
					var nsfw = "'1'";
				}
				else {
					var nsfw = "'0'";
				}
				con.query("INSERT INTO posts (post, ip, hash_id, nsfw, time, attachment) VALUES ("+safeText+", "+format.literal(ip)+", "+format.literal(hash(salt+ip))+", "+nsfw+", "+time+", "+attachment+");", function (e) {
					if (e) throw e;

					con.query("SELECT * FROM posts WHERE \"post\" = "+safeText+" AND \"post\" NOT LIKE '%#bonfyre%' AND \"ip\" = '"+ip+"' AND \"time\" = '"+time+"';", function (e, posts) {
						if (e) throw e;

						//Send the posts to the user
						if (posts.rows.length > 0) {
							var post = posts.rows[posts.rows.length-1];
							con.query('SELECT * FROM comments WHERE \"parent\" = '+post.id+';', (function(post, e, comments) {
								if (e) throw e;

								if (comments.rows.length === 1) {
									post.commentNum = comments.rows.length+' comment';
								}
								else {
									post.commentNum = comments.rows.length+' comments';
								}

								for (var j = 0; j < comments.rows.length; ++j) {
									comments.rows[j].ip = 'http://robohash.org/'+hash(salt+comments.rows[j].ip)+'.png?set=set4&size=64x64';
								}

								post.comments = comments.rows;

								post.ip = 'http://robohash.org/'+hash(salt+post.ip)+'.png?set=set4&size=64x64';
								post.loadBottom = false;

								delete post.notifylist;
								delete post.voters;

								ws.emit('new post', JSON.stringify(post));
								socket.emit('success message', JSON.stringify({title: 'Post submitted', body: ''}));

								//If the user isn't showing NSFW posts, and this post is NSFW show them
								if (nsfw === "'1'") {
									socket.emit('show nsfw');
								}
							}).bind(this, post));
						}
						else {
							socket.emit('success message', JSON.stringify({title: 'Post submitted', body: ''}));
						}
					});
				});
			}
			else if (spamming) {
				socket.emit('error message', JSON.stringify({title: 'Post not submitted', body: "You've posted too much recently"}));
			}
			else {
				socket.emit('error message', JSON.stringify({title: 'Post not submitted', body: 'Your post is too long'}));
			}
		}
		else {
			socket.emit('error message', JSON.stringify({title: 'Post not submitted', body: 'No data was received'}));
		}
	});
}

function submitComment(parent, text, catcher, ip, commentParent, socket) {
	var time = Math.floor(Date.now() / 1000) - 5;
	text = text.replace(/(<([^>]+)>)/ig,"");
	safeText = format.literal(text);
	var spamming = false;
	if (catcher.length > 0) spamming = true;
	if (!commentParent) commentParent = null;

	if (text && ip && parent) {
		if (text.length <= 256 && !spamming) {
			con.query("INSERT INTO comments (comment, ip, parent, parentcomment, time) VALUES ("+safeText+", "+format.literal(ip)+", "+format.literal(parent)+", "+format.literal(commentParent)+", '"+time+"');", function (e) {
				//Tell the user and show the comment
				socket.emit('success message', JSON.stringify({title: 'Comment submitted', body: ''}));

				con.query("SELECT * FROM comments WHERE \"comment\" = "+safeText+" AND \"ip\" = '"+ip+"' AND \"time\" = '"+time+"';", function(e, commentData) {
					var commentData = commentData.rows[commentData.rows.length-1];
					commentData.ip = 'http://robohash.org/'+hash(salt+commentData.ip)+'.png?set=set4&size=64x64'
					ws.emit('new comment', JSON.stringify(commentData));

					//Notifications
					con.query("SELECT \"notifylist\" FROM \"posts\" WHERE \"id\" = '"+addslashes(parent)+"';", function(e, results) {
							var notifylist = results.rows[0].notifylist;
							var update = false;
							if (notifylist) {
								notifylist = JSON.parse(notifylist);
								for (var i = notifylist.IPs.length - 1; i >= 0; i--) {
									if (notifylist.IPs[i] === ip) continue;

									const ipToNotify = notifylist.IPs[i];
									con.query("INSERT INTO \"notifications\" (ip, commentText, postID, commentID) VALUES ("+format.literal(ipToNotify)+", "+safeText+", "+format.literal(parent)+", "+commentData.id+");", () => {
										const socketToNotify = users[ipToNotify];
										if (!!socketToNotify) getNotifications(ipToNotify, socketToNotify);
									});
								}
							}
					});
				});
			});
		}
		else if (spamming) {
			socket.emit('error message', JSON.stringify({title: 'Post not submitted', body: "You've posted too much recently"}));
		}
		else {
			socket.emit('error message', JSON.stringify({title: 'Post not submitted', body: 'Your post is too long'}));
		}
	}
	else {
		socket.emit('error message', JSON.stringify({title: 'Post not submitted', body: 'No data was received'}));
	}
}

function getCommentThread(parent, socket) {
	con.query("SELECT * FROM \"comments\" WHERE \"parentcomment\" = "+format.literal(parent)+";", function(e, comments) {
		if (e) throw e;

		for (var i = 0; i < comments.rows.length; ++i) {
			comments.rows[i].ip = 'http://robohash.org/'+hash(salt+comments.rows[i].ip)+'.png?set=set4&size=64x64';
			comments.rows[i].getChildren = true;
			comments.rows[i].dontCount = true;
			socket.emit('new comment', JSON.stringify(comments.rows[i]));
		}
	});
}

function getBulkComments(parent, socket) {
	con.query("SELECT * FROM \"comments\" WHERE \"parent\" = "+format.literal(parent)+";", function(e, comments) {
		if (e) throw e;

		for (var i = 0; i < comments.rows.length; ++i) {
			comments.rows[i].ip = 'http://robohash.org/'+hash(salt+comments.rows[i].ip)+'.png?set=set4&size=64x64';
			comments.rows[i].dontCount = true;
			socket.emit('new comment', JSON.stringify(comments.rows[i]));
		}
	});
}

function getPostInternal(size, id, ip, callback) {
	con.query("SELECT * FROM \"posts\" WHERE \"id\" = "+format.literal(id)+";", function(e, post) {
		if (!post) {
			callback({});
			return;
		}
		post = post.rows[0];
		if (!post) {
			callback({});
			return;
		}
		con.query('SELECT * FROM comments WHERE \"parent\" = '+post.id+';', (function(post, e, comments) {
			if (e) throw e;

			if (comments.rows.length === 1) {
				post.commentNum = comments.rows.length+' comment';
			}
			else {
				post.commentNum = comments.rows.length+' comments';
			}

			for (var j = 0; j < comments.rows.length; ++j) {
				comments.rows[j].ip = 'http://robohash.org/'+hash(salt+comments.rows[j].ip)+'.png?set=set4&size='+size;
			}

			post.comments = comments.rows;

			post.ip = 'http://robohash.org/'+hash(salt+post.ip)+'.png?set=set4&size='+size;
			post.loadBottom = false;

			//Are we subscribed to this post?
			con.query("SELECT \"notifylist\" FROM \"posts\" WHERE \"id\" = '"+addslashes(post.id)+"';", function(e, results) {
				var notifylist = results.rows[0].notifylist;
				if (notifylist) {
					notifylist = JSON.parse(notifylist);
					if (notifylist.IPs.indexOf(ip) <= -1) {
						post.subscribed = false;
					}
					else {
						post.subscribed = true;
					}
				}
				else {
					post.subscribed = false;
				}

				// Clear out data. This is not how you should do this.
				post = { ...post };
				delete post.voters;
				delete post.notifylist;
				callback(post);
			});
		}).bind(this, post));
	});
}

function getPost(size, id, socket, ip) {
	getPostInternal(size, id, ip, post => socket.emit('new post', JSON.stringify(post)));
}

function getStokeCount(id, socket) {
	con.query("SELECT \"score\" FROM \"posts\" WHERE \"hash_id\" = "+format.literal(id)+";", function(e, results) {
		if (!results.rows) return;

		totalScore = 0;
		for (var l = 0; l < results.rows.length; ++l) {
			totalScore += results.rows[l].score;
		}
		socket.emit('score result', JSON.stringify({score: totalScore}));
	});
}

function subscribe(id, subscribe, ip, socket) {
	if (subscribe) {
		//Subscribe to new comments
		con.query("SELECT \"notifylist\" FROM \"posts\" WHERE \"id\" = '"+addslashes(id)+"';", function(e, results) {
				var notifylist = results.rows[0].notifylist;
				var update = false;
				if (notifylist) {
					notifylist = JSON.parse(notifylist);
					if (notifylist.IPs.indexOf(ip) <= -1) {
						notifylist.IPs.push(ip);
						notifylist = JSON.stringify(notifylist);
						var update = true;
					}
				}
				else {
					notifylist = JSON.stringify({IPs:[ip]});
					var update = true;
				}

				if (update) {
					//Update database with new array
					con.query("UPDATE \"posts\" SET \"notifylist\" = '"+notifylist+"' WHERE \"id\" = '"+addslashes(id)+"';", function(e) {
						if (e) socket.emit('error message', JSON.stringify({title: 'Subscription failed', body: 'Please try again later'}));

						socket.emit('success message', JSON.stringify({title: 'Subscribed', body: ''}));
					});
				}
				else {
					socket.emit('error message', JSON.stringify({title: 'Subscription failed', body: 'You are already subscribed to this post'}));
				}
		});
	}
	else {
		con.query("SELECT \"notifylist\" FROM \"posts\" WHERE \"id\" = '"+addslashes(id)+"';", function(e, results) {
				var notifylist = results.rows[0].notifylist;
				if (notifylist) {
					notifylist = JSON.parse(notifylist);
					if (notifylist.IPs.indexOf(ip) > -1) {
						notifylist.IPs.splice(notifylist.IPs.indexOf(ip), 1);
						notifylist = JSON.stringify(notifylist);
						con.query("UPDATE \"posts\" SET \"notifylist\" = '"+notifylist+"' WHERE \"id\" = '"+addslashes(id)+"';", function(e) {
						if (e) socket.emit('error message', JSON.stringify({title: 'Unsubscription failed', body: 'Please try again later'}));

						socket.emit('success message', JSON.stringify({title: 'Unsubscribed', body: ''}));
					});
					}
				}
		});
	}
}

function getNotifications(ip, socket) {
	con.query("SELECT * FROM \"notifications\" WHERE \"ip\" = "+format.literal(ip)+";", function(e, notifications) {
		const message = (notifications.rows || [])
			.map(n => {
				let tmp = { ...n };
				delete tmp.ip;
				return tmp;
			})

		socket.emit('notification', JSON.stringify(message));
		con.query("DELETE FROM \"notifications\" WHERE \"ip\" = '"+addslashes(ip)+"';");
	});
}

app.get('/', function(req, res) {
	res.send("We didn't start the fire. It was always burning. Since the world's been turning.");
});

app.get('/tmp-api/post/:id', function(req, res) {
	res.header("Access-Control-Allow-Origin", "*");

	const postId = req.params.id;
	try {
		getPostInternal(64, postId, req.connection.remoteAddress, post => {
			console.log(post);
			res.send(JSON.stringify(post));
		});
	} catch (e) {
		console.log(e);
		res.statusCode = 400;
		res.send('Invalid Request');
	}
});

ws.on('connection', function(socket) {
	socket.on('get posts', function(params) {
		try {
			params = JSON.parse(params);
			getPosts(getCampfyreId(params), params.size, params.search, params.startingPost, params.loadBottom, socket, params.reverse, params.user, params.batch);
		}
		catch(e) {
		}
	});
	socket.on('stoke', function(params) {
		try {
			params = JSON.parse(params);
			var ip = getCampfyreId(params);
			stoke(params.id, ip, socket)
		} catch(e) { }
	});
	socket.on('submit post', function(params) {
		try {
			params = JSON.parse(params);
			var ip = getCampfyreId(params);
			submitPost(params.post, params.attachment, params.catcher, ip, params.nsfw, socket);
		} catch(e) { }
	});
	socket.on('submit comment', function(params) {
		try {
			params = JSON.parse(params);
			var ip = getCampfyreId(params);
			submitComment(params.parent, params.comment, params.catcher, ip, params.commentParent, socket);
		} catch(e) { }
	});
	socket.on('get comment thread', function(params) {
		try {
			params = JSON.parse(params);
			getCommentThread(params.parent, socket);
		}
		catch (e) {}
	});
	socket.on('get bulk comments', function(params) {
		try {
			params = JSON.parse(params);
			getBulkComments(params.parent, socket);
		}
		catch (e) {}
	});
	socket.on('get post', function(params) {
		try {
			params = JSON.parse(params);
			getPost(params.size, params.id, socket, getCampfyreId(params));
		}
		catch(e) {
		}
	});
	socket.on('get total score', function(params) {
		try {
			params = JSON.parse(params);
			getStokeCount(params.id, socket);
		}
		catch(e) {}
	});
	socket.on('subscribe', function(params) {
		try {
			params = JSON.parse(params);
			subscribe(params.id, params.subscribe, getCampfyreId(params), socket);
		}
		catch(e) {}
	});
	socket.on('get notifications', function(params) {
		try {
			params = JSON.parse(params);
			users[getCampfyreId(params)] = socket;
			getNotifications(getCampfyreId(params), socket);
		}
		catch(e) {}
	});
});

function getCampfyreId(params) {
	return params.campfyreId || generateGuid();
}

// Thanks https://stackoverflow.com/a/105074
function generateGuid() {
	function s4() {
		return Math.floor((1 + Math.random()) * 0x10000)
			.toString(16)
			.substring(1);
	}
	return s4() + s4() + '-' + s4() + '-' + s4() + '-' + s4() + '-' + s4() + s4() + s4();
}

function hash(input) {
	if (input === salt + adminId) {
		return 'admin';
	}

	return crypto.createHash('sha256').update(input).digest('hex');
}

http.listen(process.env.PORT, function(){
	console.log('listening on *:'+process.env.PORT);
});

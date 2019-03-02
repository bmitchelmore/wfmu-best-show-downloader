const puppeteer = require('puppeteer');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const process = require('process');
const sanitize = require('sanitize-filename');
const prettysize = require('prettysize');
const url = require('url');
const mkdirp = require('mkdirp');

const concurrent = getNumber(process.argv.slice(-1).pop(), process.env.CONCURRENT) || 5;
const podcast = (function(name) { return { name: name, downloads: path.resolve(`./downloads/${name}`) }; })('wfmu');

function getNumber(...values) {
    for (value of values) {
        let parsed = parseInt(value, 10);
        if (!isNaN(parsed)) return parsed;
    }
    return null;
}

var ProcessState = function() {
    this.text = "";
};

var PodcastState = function(p, c) {
    var podcast = p;
    var children = c || [];
    
    Object.defineProperty(this, 'podcast', {
        get: function() {
            return podcast ? Object.freeze(podcast) : null;
        }
    });
    Object.defineProperty(this, 'children', {
        get: function() {
            return Object.freeze(children);
        }
    });
};

PodcastState.prototype.print = function print() {
    if (this.finished) return;
    var children = this.children;
    var width = process.stdout.columns;
    if (this.clear_screen) {
        var blank = new Array(width).join(" ");
        var O33 = "\033";
        var reset = `${O33}[${children.length}A${O33}[${width}D`;
        console.log(reset);
        console.log("\033[2A");
    } else {
        this.clear_screen = true;
    }
    children.forEach(function(state) {
        var text = state.text || "";
        var substring = text.substring(0, width - 4);
        console.log((substring == state.text ? state.text : substring + "...") + "\033[K");
    });
};

PodcastState.prototype.start = function start() {
    console.log(`Updating ${this.podcast.name}`);
    this.interval = setInterval(() => this.print(), 50);
};

PodcastState.prototype.finish = function finish(size) {
    if (this.interval) clearInterval(this.interval);
    this.print();
    this.finished = true;
    console.log(`Total size: ${prettysize(size)}`);
    console.log("Done");
};

var load_raw_url = function(str) {
    var parsed = url.parse(str);
    return load_url(parsed);
};

var load_url = function(obj) {
    return new Promise(function(resolve, reject) {
        https.request(obj, function(response) {
            var statusCode = response.statusCode;
            if (statusCode == 301 || statusCode == 302) {
                var loc = response.headers.location
                var dest = url.parse(loc);
                if (!/^https?:/.test(loc)) {
                    dest = url.resolve(url.format(obj), loc);
                } 
                resolve(load_url(dest));
            } else if (statusCode >= 400) {
                reject(new Error(`Invalid HTTP Response: ${statusCode}`));
            } else {
                var str = '';
                
                response.on('data', function(chunk) {
                    str += chunk;
                });
                
                response.on('error', function(err) {
                    reject(err);
                });
                
                response.on('end', function() {
                    resolve(str)
                });
            }
        }).end();
    });
};

var find_download_url = async function find_download_url(item, state) {
    return new Promise(function(resolve, reject) {
        state.text = `Finding info url for ${item.title}`;
        load_raw_url(item.url).then(function(html) {
            var match;
            if (match = /<textarea id="playlist-data".*?>(.*?)<\/textarea>/sim.exec(html)) {
                var string = match.pop();
                var json = JSON.parse(string);
                var audio = json.audio['@attributes'].url
                var path = audio.split(':').slice(-1)[0];
                var server = json.mp4_server;
                var url = `https:${server}${path}`;
                item.download_url = url;
                resolve(item);
            } else {
                console.log(`failed to find playlist-data in html: ${html}`);
                reject(new Error("No url found"));
            }
        });
    });
};

var download_destination = function download_destination(podcast, item, remote) {
    var dir = podcast.downloads;
    var name = clean_string(`[${item.index}] ${item.title}`);
    var ext = path.extname(remote);
    var base = [name, ext].join('');
    var options = { dir: dir, name: name, ext: ext, base: base };
    var formatted = path.format(options);
    return formatted;
};

var check_file = function check_file(local) {
    return new Promise(function(resolve, reject) {
        fs.stat(local, function(err, stats) {
            if (err) {
                resolve(null);
            } else {
                resolve(stats);
            }
        });
    });
};

var write_file = function write_file(remote, temp, local, progress) {
    return new Promise(function(resolve, reject) {
        var file = fs.createWriteStream(temp);
        file.on('open', function(fd) {
            let client = remote.startsWith("https") ? https : http;
            var request = client.get(remote, function(response) {
                var statusCode = response.statusCode;
                var total = parseInt(response.headers['content-length'], 10);
                var current = 0;
                var percent = 0;
                var size = 0;
                var etag = response.headers.etag;
                
                if (statusCode == 301 || statusCode == 302) {
                    var loc = response.headers.location;
                    file.end();
                    resolve(write_file(loc, temp, local, progress));
                } else if (statusCode >= 400) { 
                    var err = new Error("Error downloading file");
                    reject(err);
                } else {
                    response.on('data', function(chunk) {
                        file.write(chunk)
                        size += chunk.length;
                        current += chunk.length;
                        percent = Math.floor(100 * current / total);
                        progress(percent);
                    }).on('error', function() {
                        file.end();
                        var err = new Error("Error downloading file");
                        reject(err);
                    }).on('end', function() {
                        file.end();
                        fs.unlink(local, function(err) {
                            fs.rename(temp, local, function(err) {
                                if (err) return reject(err);
                                fs.stat(local, function(err, stats) {
                                    if (err) return reject(err);
                                    resolve(stats.size);
                                });
                            });
                        });
                    });
                }
            });
            request.on("error", function(err) {
                reject(err);
            });
        });
    });
};

var download_audio_file = async function(podcast, item, state) {
    state.text = `Downloading mp3 file for ${item.title}`;
    
    item.dest = download_destination(podcast, item, item.download_url);
    item.tmp_dest = [item.dest, 'tmp'].join('.');
    
    let stats = await check_file(item.dest);
    if (stats) {
        state.text = `Cached ${item.title}`;
        item.size = stats.size;
        return item;
    } else {
        let progress = (percent) => state.text = `Downloading ${item.title} ${percent}%`;
        let size = await write_file(item.download_url, item.tmp_dest, item.dest, progress)
        item.size = size;
        return item;
    }
};

var download_remote_item = async function(podcast, item, state) {
    let url = await find_download_url(item, state);
    await download_audio_file(podcast, item, state);
    return item
};

var clean_string = function clean_string(string) {
    return sanitize(string.split(path.sep).join('–').split(/[/\\]/g).join('-').replace("&amp;", "and").replace("&nbsp;", " "));
};

var src_ext = function src_ext(src) {
    return path.extname(src).split('?').shift();
};

var refresh_item = function refresh_item(podcast, item, state) {
    return download_remote_item(podcast, item, state);
};

var process_items = async function process_items(podcast, items, state) {
    var results = [];
    var item = items.shift()
    while (item) {
        state.text = `Starting ${item.title}`;
        try {
            let result = await refresh_item(podcast, item, state);
            state.text = `Finished ${item.title}`;
            results.push(result);
        } catch {
            state.text = `Error ${item.title}: ${err}`;
        }
        item = items.shift();
    }
    return results;
};

var observe_processes = async function observe_processes(podcast, processes, state) {
    state.start();
    let results = await Promise.all(processes).catch(err => {
        throw err
    });
    var items = results.reduce((array, add) => array.concat(add), []);
    var size = items.reduce((sum, item) => sum + item.size, 0);
    state.finish(size);
};

var make_list = function make_list(size) {
    var list = [];
    var index = 0;
    while (index < size) {
        list.push(index);
        index++;
    }
    return list;
};

var transform_episode_list = function transform_episode_list(episodes) {
    return [].concat.apply([], episodes).map(function(item, index, array) {
        item.index = array.length - index;
        item.src = item.url;
        return item;
    }).sort(function(first, second) {
        return first.index - second.index;
    });
};

var make_dir = async function(path) {
    let promise = await new Promise((resolve, reject) => {
        mkdirp(path, function(err) {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    }).catch(err => {
        throw err
    });
    return promise;
};

var process_podcast = async function(podcast, episodes) {
    await make_dir(podcast.downloads);
    var items = transform_episode_list(episodes);
    var states = make_list(concurrent).map(i => new ProcessState());
    var state = new PodcastState(podcast, states);
    var processes = state.children.map(state => process_items(podcast, items, state));
    return observe_processes(podcast, processes, state);
};

var load_podcast = async function load_podcast(location) {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.goto(location);
    const episodes = await page.evaluate(() => {
        var query = Array.prototype.slice.call(window.document.querySelectorAll("a"));
        var test = function(el) {
            return /^\/flashplayer.php/.test(el.getAttribute("href"));
        };
        var make = function(el) {
            return {
                title: el.parentElement.textContent.split("| Listen:")[0].trim().replace(/\n+/, " ").split(":").shift(),
                url: "https://wfmu.org" + el.getAttribute("href")
            };
        };
        return query.filter(test).map(make);
    })
    return episodes;
};

const run = async() => {
    const episodes = await load_podcast("https://wfmu.org/playlists/BS");
    await process_podcast(podcast, episodes)
};

run();

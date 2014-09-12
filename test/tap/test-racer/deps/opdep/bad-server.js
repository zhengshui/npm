var createServer = require("http").createServer
var spawn = require("child_process").spawn
var fs = require("fs")
var path = require("path")
var pidfile = path.resolve(__dirname, "..", "..", "child.pid")
var rimraf = require("rimraf")

if (process.argv[2]) {
  createServer(function (req, res) {
    setTimeout(function () {
      res.writeHead(404)
      res.end()
    }, 1000)
    this.close()
  }).listen(8080)
}
else {
  var child = spawn(
    process.execPath,
    [__filename, "whatever"],
    {
      stdio: [
        "ignore",
        process.stdout,
        process.stderr
      ],
      detached: true
    }
  )
  child.unref()

  // kill any prior children, if existing.
  try {
    var pid = +fs.readFileSync(pidfile)
    process.kill(pid, "SIGKILL")
  } catch (er) {}

  console.error(pidfile)
  fs.writeFileSync(__dirname + '/child.pid', child.pid + '\n')
}

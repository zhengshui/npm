var createServer = require("http").createServer
var spawn = require("child_process").spawn
var fs = require("fs")
var path = require("path")
var pidfile = path.resolve(__dirname, "..", "..", "child.pid")
var rimraf = require("rimraf")

if (process.argv[2]) {
  console.error("bad-server.js child")
  console.log("ok")
  createServer(function (req, res) {
    setTimeout(function () {
      res.writeHead(404)
      res.end()
    }, 1000)
    this.close()
  }).listen(8080)
}
else {
  console.error("bad-server.js parent")
  var child = spawn(
    process.execPath,
    [__filename, "whatever"],
    {
      stdio: [0, 1, 2],
      detached: true
    }
  )
  child.unref()

  // kill any prior children, if existing.
  try {
    var pid = +fs.readFileSync(pidfile)
    process.kill(pid, "SIGKILL")
  } catch (er) {}

  fs.writeFileSync(pidfile, child.pid + '\n')
  // child.stdout.on("readable", function() {
  //   process.exit()
  // })
  // Give it a sec for the child to do something
  setTimeout(function() {}, 50)
}

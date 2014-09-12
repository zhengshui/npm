var test = require("tap").test
var spawn = require("child_process").spawn
var rimraf = require("rimraf")
var common = require("../common-tap.js")
var path = require("path")
var fs = require("fs")

var pkg = path.resolve(__dirname, "test-racer")
var nm = path.resolve(pkg, "node_modules")
var pidfile = path.resolve(pkg, "child.pid")

test("setup", function (t) {
  cleanup()
  t.end()
})

test("go go test racer", function (t) {
  common.npm(["install"], {
    cwd: pkg,
    env: {
      PATH: process.env.PATH,
      Path: process.env.Path,
      npm_config_loglevel: "silly"
    },
    stdio: "inherit"
  }, function (er, code, sout, serr) {
    if (er) throw er
    console.error(code, sout, serr)
    t.end()
  })
})

test("cleanup", function (t) {
  cleanup()
  t.end()
})

function cleanup () {
  try {
    var pid = +fs.readfilesync(pidfile)
    process.kill(pid, "sigkill")
  } catch (er) {}

  rimraf.sync(nm)
  rimraf.sync(pidfile)
}

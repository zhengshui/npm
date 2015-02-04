"use strict"
var npm = require("./npm.js")
var addRemoteTarball = require("./cache/add-remote-tarball.js")
var addRemoteGit = require("./cache/add-remote-git.js")
var mapToRegistry = require("./utils/map-to-registry.js")
var cache = require("./cache.js")
var cachedPackageRoot = require("./cache/cached-package-root.js")
var fs = require("fs")
var path = require("path")
var log = require("npmlog")
var realizePackageSpecifier = require("realize-package-specifier")
var readJson = require("read-package-json")
var tar = require("tar")
var zlib = require("zlib")
var once = require("once")
var semver = require("semver")
var inflight = require("inflight")
var readPackageTree = require("read-package-tree")

module.exports = function fetchPackageMetadata (spec, where, tracker, cb) {
  if (!cb) {
    cb = tracker || where
    tracker = null
    if (cb === where) where = null
  }
  log.silly("fetchPackageMetaData", spec)
  realizePackageSpecifier(spec, where, function (er, dep) {
    if (er) {
      log.silly("fetchPackageMetaData", "error for "+spec, er)
      if (tracker) tracker.finish()
      return cb(er)
    }
    var normalized = dep.name === null ? dep.spec : dep.name + "@" + dep.spec
    function addRequested (dep, cb) {
      return function (err, p) {
        if (tracker) tracker.finish()
        if (p) {
          p.requested = dep
        }
        cb(err,p)
      }
    }
    cb = addRequested(dep, cb)
    cb = addShrinkwrap(dep, where, cb)
    cb = addBundled(dep, where, cb)

    cb = inflight("fetchPackageMetadata" + normalized, cb)
    if (!cb) return

    switch (dep.type) {
    case "git":
      fetchGitPackageData(dep, cb)
      break
    case "local":
      fs.stat(dep.spec, function (er, stat) {
        if (er) return cb(er)
        if (stat.isDirectory()) {
          // If the local module is a directory but was detected as "local" it means
          // that there was no package.json
          var er = new Error("Missing package.json in "+dep.spec)
          er.code = "ENOPACKAGEJSON"
          return cb(er)
        }
        fetchLocalTarPackageData(dep, cb)
      })
      break
    case "directory":
      fetchDirectoryPackageData(dep, cb)
      break
    case "remote":
      fetchRemoteTarPackageData(dep, cb)
      break
    case "hosted":
      fetchHostedGitPackageData(dep, cb)
      break
    default:
      fetchNamedPackageData(dep, cb)
    }
  })
}


// Add a shrinkwrap attribute to the package-json object that contains the
// parsed npm-shrinkwrap if there is one.
function addShrinkwrap (dep, where, cb) {
  return function (err, pkg) {
    if (err) return cb(err)
    if (pkg.shrinkwrap) return cb(err, pkg)
    // FIXME: cache the shrinkwrap directly
    var pkgname = pkg.name
    var ver = pkg.version
    var tarball = path.join(cachedPackageRoot({name : pkgname, version : ver}), "package.tgz")
    var untar = untarStream(tarball, cb)
    var foundShrinkwrap = false
    untar.on("entry", function (entry) {
      if (!/^(?:[^\/]+[\/])npm-shrinkwrap.json$/.test(entry.path)) return
      var foundShrinkwrap = true
      var shrinkwrap = ""
      entry.on("data", function (chunk) {
        shrinkwrap += chunk
      })
      entry.on("end", function () {
        untar.close()
        try {
          pkg.shrinkwrap = JSON.parse(shrinkwrap)
        }
        catch (er) {
          er = new Error("Error parsing "+pkgname+"@"+ver+"'s npm-shrinkwrap.json: "+er.message)
          er.type = "ESHRINKWRAP"
          return cb(er)
        }
        cb(null, pkg)
      })
      entry.resume()
    })
    untar.on("end", function () {
      if (!foundShrinkwrap) cb(null, pkg)
    })
  }
}

// Add a bundled attribute to modules that declare bundled dependencies
// that contains read-package-tree Node objects in a tree representing
// those node_modules in the tarball.
function addBundled (dep, where, cb) {
  return function (err, pkg) {
    if (err) return cb(err)
    if (pkg.bundled) return cb(null, pkg)
    pkg.bundled = []
    if (!pkg.bundleDependencies || !pkg.bundleDependencies.length) return cb(null, pkg)
    var pkgname = pkg.name
    var ver = pkg.version
    var tarball = path.join(cachedPackageRoot({name : pkgname, version : ver}), "package.tgz")
    var modules = {}
    var untar = untarStream(tarball, cb)
    untar.on("entry", function (entry) {
      if (this.type.match(/^.*Link$/)) return
      var matched = entry.path.match(/^((?:[^/]+[/]node_modules[/])*)([^/]+)[/]package.json$/)
      if (matched.length === 0) return
      var parent = matched[1]
      var pkgname = matched[2]
      require("npmlog").warn("addBundled", entry.path)
      var raw = ""
      entry.on("data", function (chunk) {
        raw += chunk
      })
      entry.on("end", function () {
        var bundledPackage
        try {
          bundledPackage = JSON.parse(shrinkwrap)
        }
        catch (er) {
          log.warn("addBundled", "Error parsing "+pkgname+"@"+ver+"'s "+entry.path+": "+er.message)
          return
        }
        if (!modules[parent]) modules[parent] = {}
        modules.parent[pkgname] = bundledPackage
      })
      entry.resume()
    })
    untar.on("end", function () {
      cb(null, pkg)
    })
  }
}

function fetchRemoteTarPackageData (dep, cb) {
  log.silly("fetchRemoteTarPackageData", dep)
  mapToRegistry(dep.name || dep.rawSpec, npm.config, function (er, url, auth) {
    addRemoteTarball(dep.spec, null, null, auth, cb)
  })
}

function fetchGitPackageData (dep, cb) {
  log.silly("fetchGitPackageData", dep)
  addRemoteGit(dep.spec, false, cb)
}

function fetchHostedGitPackageData (dep, cb) {
  log.silly("fetchHostedGitPackageData", dep.hosted.directUrl)

  npm.registry.get(dep.hosted.directUrl, npm.config, function (er, p) {
    if (!er) return cb(er, p)
    log.silly("fetchHostedGitPackageData", er)
    log.silly("fetchHostedGitPackageData", dep.hosted.ssh)
    addRemoteGit(dep.hosted.httpsUrl, false, function (er, p) {
      if (!er) return cb(er, p)
      addRemoteGit(dep.hosted.ssh, false, cb)
    })
  })
}

function fetchNamedPackageData (dep, cb) {
  log.silly("fetchNamedPackageData", dep.name || dep.rawSpec)
  mapToRegistry(dep.name || dep.rawSpec, npm.config, function (er, url, auth) {
    cb = inflight(url, cb)
    if (!cb) return
    npm.registry.get(url, {auth: auth}, function (er, p) {
      if (er) return cb(er)
      var versions = Object.keys(p.versions).sort(semver.rcompare)

      if (dep.type === "tag") {
        var tagVersion = p["dist-tags"][dep.spec]
        if (p.versions[tagVersion]) return cb(null, p.versions[tagVersion])
      }
      else {
        var latestVersion = p["dist-tags"].latest || versions[0]

        // Find the the most recent version less than or equal
        // to latestVersion that satisfies our spec
        for (var ii=0; ii<versions.length; ++ii) {
          if (semver.gt(versions[ii], latestVersion)) continue
          if (semver.satisfies(versions[ii], dep.spec)) {
            return cb(null, p.versions[versions[ii]])
          }
        }

        // Failing that, try finding the most recent version that matches
        // our spec
        for (var ii=0; ii<versions.length; ++ii) {
          if (semver.satisfies(versions[ii], dep.spec)) {
            return cb(null, p.versions[versions[ii]])
          }
        }
      }

      // And failing that, we error out
      var targets = versions.length
                  ? "Valid install targets:\n" + JSON.stringify(versions) + "\n"
                  : "No valid targets found."
      var er = new Error("No compatible version found: "
                       + dep.rawSpec + "\n" + targets)
      return cb(er)
    })
  })
}

function untarStream (tarball, cb) {
  cb = once(cb)
  var file = fs.createReadStream(tarball)
  file.on("error", function (er) {
    er = new Error("Error extracting "+tarball+" archive: " + er.message)
    er.code = "EREADFILE"
    cb(er)
  })
  var gunzip = file.pipe(zlib.createGunzip())
  gunzip.on("error", function (er) {
    er = new Error("Error extracting "+tarball+" archive: " + er.message)
    er.code = "EGUNZIP"
    cb(er)
  })
  var untar = gunzip.pipe(tar.Parse())
  untar.on("error", function (er) {
    er = new Error("Error extracting "+tarball+" archive: " + er.message)
    er.code = "EUNTAR"
    cb(er)
  })
  untar.close = function () {
    gunzip.unpipe(untar)
    file.unpipe(gunzip)
    file.close()
  }
  return untar
}

function fetchLocalTarPackageData (dep, cb) {
  log.silly("fetchLocalTarPackageData", dep.spec)
  cb = inflight("fetchLocalTarPackageData" + dep.spec, cb)
  if (!cb) return
  cb = once(cb)
  var untar = untarStream(dep.spec, cb)
  var foundPackageJson = false
  untar.on("entry", function (entry) {
    if (foundPackageJson) return
    if (!/^(?:[^\/]+[\/])package.json$/.test(entry.path)) return
    foundPackageJson = true
    extractPackageJson(entry)
  })
  untar.on("end", function () {
    if (!foundPackageJson) {
      cb(new Error("No package.json found in "+dep.spec))
    }
  })
  var extractPackageJson = function (entry) {
    var json = ""
    entry.on("data", function (chunk) { json += chunk })
    entry.on("end", function () {
      untar.close()
      var pkg
      try {
        pkg = JSON.parse(json)
      }
      catch (ex) {
        var er = new Error("Failed to parse json\n"+ex.message)
        er.code = "EJSONPARSE"
        er.file = path.join(dep.spec,entry.path)
        return cb(er)
      }
      cb(null, pkg)
    })
  }
}

function fetchDirectoryPackageData (dep, cb) {
  log.silly("fetchDirectoryPackageData", dep.rawSpec, "=", dep.spec)
  cb = inflight("fetchDirectoryPackageData" + dep.spec, cb)
  readJson(path.join(dep.spec, "package.json"), false, function (er, data) {
    if (er) return cb(er)
    if (!data.name) return cb(new Error("No name provided for " + dep.rawSpec))
    if (!data.version) return cb(new Error("No version provided for " + dep.rawSpec))
    if (dep.name && dep.name !== data.name) {
      return cb(new Error("Invalid Package: expected " + dep.name
        + " but found " + data.name))
    }
    cb(null, data)
  })
}

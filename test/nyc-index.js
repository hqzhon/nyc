/* global describe, it, beforeEach */

require('source-map-support').install({ hookRequire: true })

const fs = require('fs')
const ap = require('any-path')

const configUtil = require('../self-coverage/lib/config-util')
const NYC = require('../self-coverage')
// we test exit handlers in nyc-integration.js.
NYC.prototype._wrapExit = () => {}

const path = require('path')
const rimraf = require('rimraf')
const isWindows = require('is-windows')()
const spawn = require('child_process').spawn
const fixtures = path.resolve(__dirname, './fixtures')
const bin = path.resolve(__dirname, '../self-coverage/bin/nyc')
const resetState = require('./helpers/reset-state')

require('chai').should()
require('tap').mochaGlobals()

const transpileHook = path.resolve(process.cwd(), './test/fixtures/transpile-hook')

describe('nyc', function () {
  beforeEach(resetState)

  describe('cwd', function () {
    it('sets cwd to process.cwd() if no environment variable is set', function () {
      var nyc = new NYC(configUtil.buildYargs().parse())

      nyc.cwd.should.eql(process.cwd())
    })

    it('uses NYC_CWD environment variable for cwd if it is set', function () {
      process.env.NYC_CWD = path.resolve(__dirname, './fixtures')
      var nyc = new NYC(configUtil.buildYargs().parse())

      nyc.cwd.should.equal(path.resolve(__dirname, './fixtures'))
    })

    it('will look upwards for package.json from cwd', function () {
      var nyc = new NYC(configUtil.buildYargs(__dirname).parse())
      nyc.cwd.should.eql(path.join(__dirname, '..'))
    })

    it('uses --cwd for cwd if it is set (highest priority and does not look upwards for package.json) ', function () {
      var nyc = new NYC(configUtil.buildYargs(__dirname).parse(['--cwd', __dirname]))
      nyc.cwd.should.eql(__dirname)
    })
  })

  describe('config', function () {
    it("loads 'exclude' patterns from package.json#nyc", function () {
      var nyc = new NYC(configUtil.buildYargs(path.resolve(__dirname, './fixtures')).parse())
      nyc.exclude.exclude.length.should.eql(8)
    })

    it("loads 'extension' patterns from package.json#nyc", function () {
      var nyc = new NYC(configUtil.buildYargs(path.resolve(__dirname, './fixtures/conf-multiple-extensions')).parse())
      nyc.extensions.length.should.eql(3)
    })

    it("ignores 'include' option if it's falsy or []", function () {
      var nyc1 = new NYC(configUtil.buildYargs(path.resolve(__dirname, './fixtures/conf-empty')).parse())

      nyc1.exclude.include.should.equal(false)

      var nyc2 = new NYC({
        include: []
      })

      nyc2.exclude.include.should.equal(false)
    })

    it("ignores 'exclude' option if it's falsy", function () {
      var nyc1 = new NYC(configUtil.buildYargs(path.resolve(__dirname, './fixtures/conf-empty')).parse())
      nyc1.exclude.exclude.length.should.eql(15)
    })

    it("allows for empty 'exclude'", function () {
      var nyc2 = new NYC({ exclude: [] })

      // an empty exclude still has **/node_modules/**, node_modules/** and added.
      nyc2.exclude.exclude.length.should.eql(2)
    })
  })

  describe('wrap', function () {
    it('wraps modules with coverage counters when they are required', function () {
      var nyc = new NYC(configUtil.buildYargs().parse())
      nyc.reset()
      nyc.wrap()

      var check = require('./fixtures/check-instrumented')
      check().should.equal(true)
    })

    describe('custom require hooks are installed', function () {
      it('wraps modules with coverage counters when the custom require hook compiles them', function () {
        let required = false
        const hook = function (module, filename) {
          if (filename.indexOf('check-instrumented.js') !== -1) {
            required = true
          }
          module._compile(fs.readFileSync(filename, 'utf8'), filename)
        }

        var nyc = new NYC(configUtil.buildYargs().parse())
        nyc.reset()
        nyc.wrap()

        // install the custom require hook
        require.extensions['.js'] = hook // eslint-disable-line

        const check = require('./fixtures/check-instrumented')
        check().should.equal(true)

        // and the hook should have been called
        required.should.equal(true)
      })
    })

    describe('produce source map', function () {
      it('handles stack traces', function () {
        var nyc = new NYC(configUtil.buildYargs().parse('--produce-source-map'))
        nyc.reset()
        nyc.wrap()

        var check = require('./fixtures/stack-trace')
        check().should.match(/stack-trace.js:4:/)
      })

      it('does not handle stack traces when disabled', function () {
        var nyc = new NYC(configUtil.buildYargs().parse())
        nyc.reset()
        nyc.wrap()

        var check = require('./fixtures/stack-trace')
        check().should.match(/stack-trace.js:1:/)
      })
    })

    describe('compile handlers for custom extensions are assigned', function () {
      it('assigns a function to custom extensions', function () {
        var nyc = new NYC(configUtil.buildYargs(
          path.resolve(__dirname, './fixtures/conf-multiple-extensions')
        ).parse())
        nyc.reset()
        nyc.wrap()

        require.extensions['.es6'].should.be.a('function') // eslint-disable-line
        require.extensions['.foo.bar'].should.be.a('function') // eslint-disable-line

        // default should still exist
        require.extensions['.js'].should.be.a('function') // eslint-disable-line
      })

      it('calls the `_handleJs` function for custom file extensions', function () {
        const required = {
          es6: false,
          custom: false
        }
        var nyc = new NYC(configUtil.buildYargs(
          path.resolve(__dirname, './fixtures/conf-multiple-extensions')
        ).parse())

        nyc['_handleJs'] = (code, options) => {
          if (options.filename.indexOf('check-instrumented.es6') !== -1) {
            required.es6 = true
          }
          if (options.filename.indexOf('check-instrumented.foo.bar') !== -1) {
            required.custom = true
          }
          return code
        }

        nyc.reset()
        nyc.wrap()

        require('./fixtures/conf-multiple-extensions/check-instrumented.es6')
        require('./fixtures/conf-multiple-extensions/check-instrumented.foo.bar')
        required.custom.should.equal(true)
        required.es6.should.equal(true)
      })
    })

    function testSignal (signal, done) {
      var nyc = (new NYC(configUtil.buildYargs(fixtures).parse()))

      var proc = spawn(process.execPath, [bin, './' + signal + '.js'], {
        cwd: fixtures,
        env: {},
        stdio: 'ignore'
      })

      proc.on('close', function () {
        const checkFile = path.join(fixtures, signal + '.js')
        const reports = nyc.loadReports().filter(report => report[checkFile])
        reports.length.should.equal(1)
        return done()
      })
    }

    it('writes coverage report when process is killed with SIGTERM', function (done) {
      if (isWindows) return done()
      testSignal('sigterm', done)
    })

    it('writes coverage report when process is killed with SIGINT', function (done) {
      if (isWindows) return done()
      testSignal('sigint', done)
    })

    it('does not output coverage for files that have not been included, by default', function (done) {
      var nyc = (new NYC(configUtil.buildYargs(process.cwd()).parse()))
      nyc.wrap()
      nyc.reset()

      const reports = nyc.loadReports().filter(report => report['./test/fixtures/not-loaded.js'])
      reports.length.should.equal(0)
      return done()
    })
  })

  describe('report', function () {
    it('allows coverage report to be output in an alternative directory', function (done) {
      var nyc = new NYC(configUtil.buildYargs().parse(
        ['--report-dir=./alternative-report', '--reporter=lcov']
      ))
      nyc.reset()

      var proc = spawn(process.execPath, ['./test/fixtures/child-1.js'], {
        cwd: process.cwd(),
        env: process.env,
        stdio: 'inherit'
      })

      proc.on('close', function () {
        nyc.report()
        fs.existsSync('./alternative-report/lcov.info').should.equal(true)
        rimraf.sync('./alternative-report')
        return done()
      })
    })
  })

  describe('addAllFiles', function () {
    it('outputs an empty coverage report for all files that are not excluded', function (done) {
      var nyc = new NYC(configUtil.buildYargs(fixtures).parse())
      nyc.reset()
      nyc.addAllFiles()

      const notLoadedPath = path.join(fixtures, './not-loaded.js')
      const reports = nyc.loadReports().filter(report => ap(report)[notLoadedPath])
      const report = reports[0][notLoadedPath]

      reports.length.should.equal(1)
      report.s['0'].should.equal(0)
      report.s['1'].should.equal(0)
      return done()
    })

    it('outputs an empty coverage report for multiple configured extensions', function (done) {
      var cwd = path.resolve(fixtures, './conf-multiple-extensions')
      var nyc = new NYC(configUtil.buildYargs(cwd).parse())
      nyc.reset()
      nyc.addAllFiles()

      const notLoadedPath1 = path.join(cwd, './not-loaded.es6')
      const notLoadedPath2 = path.join(cwd, './not-loaded.js')
      const reports = nyc.loadReports().filter(report => {
        var apr = ap(report)
        return apr[notLoadedPath1] || apr[notLoadedPath2]
      })

      reports.length.should.equal(1)

      var report1 = reports[0][notLoadedPath1]
      report1.s['0'].should.equal(0)
      report1.s['1'].should.equal(0)

      var report2 = reports[0][notLoadedPath2]
      report2.s['0'].should.equal(0)
      report2.s['1'].should.equal(0)

      return done()
    })

    it('tracks coverage appropriately once the file is required', function (done) {
      var nyc = (new NYC(configUtil.buildYargs(fixtures).parse()))
      nyc.reset()
      nyc.wrap()

      require('./fixtures/not-loaded')

      nyc.writeCoverageFile()

      const notLoadedPath = path.join(fixtures, './not-loaded.js')
      const reports = nyc.loadReports().filter(report => report[notLoadedPath])
      const report = reports[0][notLoadedPath]

      reports.length.should.equal(1)
      report.s['0'].should.equal(1)
      report.s['1'].should.equal(1)

      return done()
    })

    it('transpiles .js files added via addAllFiles', function (done) {
      fs.writeFileSync(
        './test/fixtures/needs-transpile.js',
        '--> pork chop sandwiches <--\nvar a = 99',
        'utf-8'
      )

      var nyc = (new NYC(configUtil.buildYargs(fixtures).parse(['--require', transpileHook])))
      nyc.reset()
      nyc.addAllFiles()

      const needsTranspilePath = path.join(fixtures, './needs-transpile.js')
      const reports = nyc.loadReports().filter(report => ap(report)[needsTranspilePath])
      const report = reports[0][needsTranspilePath]

      reports.length.should.equal(1)
      report.s['0'].should.equal(0)

      fs.unlinkSync(needsTranspilePath)
      return done()
    })

    it('does not attempt to transpile files when they are excluded', function (done) {
      var notNeedTranspilePath = path.join(fixtures, './do-not-need-transpile.do-not-transpile')
      fs.writeFileSync(
        notNeedTranspilePath,
        '--> pork chop sandwiches <--\nvar a = 99',
        'utf-8'
      )

      var nyc = (new NYC(configUtil.buildYargs(fixtures).parse([
        `--require=${transpileHook}`,
        '--extension=.do-not-transpile',
        '--include=needs-transpile.do-not-transpile'
      ])))

      nyc.reset()
      nyc.addAllFiles()
      fs.unlinkSync(notNeedTranspilePath)
      return done()
    })
  })

  it('transpiles non-.js files added via addAllFiles', function (done) {
    fs.writeFileSync(
      './test/fixtures/needs-transpile.whatever',
      '--> pork chop sandwiches <--\nvar a = 99',
      'utf-8'
    )

    var nyc = (new NYC(configUtil.buildYargs(fixtures).parse([
      `--require=${transpileHook}`,
      '--extension=.whatever'
    ])))

    nyc.reset()
    nyc.addAllFiles()

    const needsTranspilePath = path.join(fixtures, './needs-transpile.whatever')
    const reports = nyc.loadReports().filter(report => ap(report)[needsTranspilePath])
    const report = reports[0][needsTranspilePath]

    reports.length.should.equal(1)
    report.s['0'].should.equal(0)

    fs.unlinkSync(needsTranspilePath)
    return done()
  })

  describe('cache', function () {
    it('handles collisions', function (done) {
      var nyc = new NYC(configUtil.buildYargs(fixtures).parse())
      nyc.clearCache()

      var args = [bin, process.execPath, './cache-collision-runner.js']

      var proc = spawn(process.execPath, args, {
        cwd: fixtures,
        env: {}
      })

      proc.on('close', function (code) {
        code.should.equal(0)
        done()
      })
    })

    it('handles identical files', function (done) {
      var nyc = new NYC(configUtil.buildYargs(fixtures).parse())
      nyc.clearCache()

      var args = [bin, process.execPath, './identical-file-runner.js']

      var proc = spawn(process.execPath, args, {
        cwd: fixtures,
        env: {}
      })

      proc.on('close', function (code) {
        code.should.equal(0)
        done()
      })
    })
  })

  describe('_disableCachingTransform', function () {
    it('is disabled if cache is "false"', function () {
      const nyc = new NYC({ cache: false })
      nyc._disableCachingTransform().should.equal(true)
    })

    it('is enabled if cache is "true" and isChildProcess is "true"', function () {
      const nyc = new NYC({
        cache: true,
        isChildProcess: true
      })
      nyc._disableCachingTransform().should.equal(false)
    })

    it('is disabled if cache is "true" and isChildProcess is "false"', function () {
      const nyc = new NYC({
        cache: true,
        isChildProcess: true
      })
      nyc._disableCachingTransform().should.equal(false)
    })
  })

  describe('cacheDirectory', function () {
    it('should resolve default cache folder to absolute path', function () {
      const nyc = new NYC({
        cache: true
      })
      path.isAbsolute(nyc.cacheDirectory).should.equal(true)
    })

    it('should resolve custom cache folder to absolute path', function () {
      const nyc = new NYC({
        cacheDir: '.nyc_cache',
        cache: true
      })
      path.isAbsolute(nyc.cacheDirectory).should.equal(true)
    })
  })
})

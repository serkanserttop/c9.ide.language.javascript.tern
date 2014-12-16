
define(function(require, exports, module) {

var tern = require("tern/lib/tern");
var infer = require("tern/lib/infer");
var worker = require("plugins/c9.ide.language/worker");
var walk = require("acorn/util/walk");
var comment = require("tern/lib/comment");
var filterDocumentation = require("plugins/c9.ide.language.jsonalyzer/worker/ctags/ctags_util").filterDocumentation;

var architectPlugins;
var warnedPlugins = {};

worker.sender.emit("architectPlugins");
worker.sender.on("architectPluginsResult", function(e) {
    architectPlugins = e.data;
});

tern.registerPlugin("architect_resolver", function(ternWorker, options) {
    ternWorker._architect = {
        modules: Object.create(null),
        currentOrigin: null
    };

    ternWorker.on("beforeLoad", function(file) {
        this._architect.currentOrigin = file.name;
    });

    // Collect architect definitions on load
    ternWorker.on("afterLoad", function(file) {
        var provides;
        walk.simple(file.ast, {
            AssignmentExpression: function(node) {
                if (!isDependencyAssign(node, "provides"))
                    return;
                provides = node.right.elements.map(function(e) {
                    return e.value;
                }).filter(function(e) {
                    return e;
                });
            },
            FunctionDeclaration: function(node) {
                if ((node.id.name !== "main" && node.id.name !== "plugin")
                    || node.params.length !== 3
                    || node.params[1].name !== "imports"
                    || node.params[2].name !== "register")
                    return;

                walk.simple(node, {
                    CallExpression: function(node) {
                        if (node.callee.name === "register"
                            && node.arguments.length >= 2
                            && node.arguments[1].type === "ObjectExpression") {
                            var arg = node.arguments[1];
                            arg.properties.forEach(function(prop) {
                                var name = prop.key.value;
                                var value = arg.objType.props[name] && arg.objType.props[name].types && arg.objType.props[name].types[0];
                                if (!value)
                                    return;
                                ternWorker._architect.modules["_" + name] = value;
                            });
                        }
                        if (node.callee.type === "MemberExpression"
                            && node.callee.property.name === "freezePublicAPI"
                            && node.arguments.length >= 1
                            && node.arguments[0].type === "ObjectExpression") {
                            if (provides.length !== 1)
                                return console.warn("[architect_resolver_worker] exporting multiple client-side plugins with freezePublicAPI() not supported");
                            var type = node.arguments[0].objType;
                            ternWorker._architect.modules["_" + provides[0]] = type;
                            
                            comment.ensureCommentsBefore(node.sourceFile.text, node);
                            if (node.commentsBefore)
                                type.doc = type.doc || filterDocumentation(node.commentsBefore[node.commentsBefore.length - 1]);
                        }
                    }
                });
            }
        });
    });

    // Assign architect definitions to 'imports.*'
    function onPostInfer(ast, scope) {
        var path = worker.$lastWorker.$path;
        var baseDirMatch = path.match(/(.*\/)plugins\//);
        if (!architectPlugins)
            console.error("[architect_resolver_worker] architectPlugins not available");

        var consumes;
        walk.simple(ast, {
            AssignmentExpression: function(node) {
                if (!isDependencyAssign(node, "consumes"))
                    return;
                consumes = node.right.elements.map(function(e) {
                    return e.value;
                }).filter(function(e) {
                    return e;
                });
            },
            FunctionDeclaration: function(node) {
                if (node.id.name !== "main"
                    || node.params.length !== 3
                    || node.params[1].name !== "imports"
                    || node.params[2].name !== "register")
                    return;

                var importsVal = node.body.scope.props.imports;

                // Seems like our argument doesn't want to complete without a type
                var type = new infer.Obj();
                importsVal.addType(type);
                
                // HACK: tern still doesn't like our type, so let's override this
                importsVal.gatherProperties = function(f) {
                    // for (var p in this.props) f(p, this, 0);
                    consumes.forEach(function(m) {
                        return f(m, importsVal, 0);
                    });
                };

                if (!consumes)
                    return console.warn("[architect_resolver_worker] main.consumes not defined");

                consumes.forEach(function(name) {
                    var path = getPath(name);
                    var def = ternWorker._architect.modules["_" + name];
                    if (!path && !def) {
                        if (!warnedPlugins[name])
                            console.warn("[architect_resolver_worker] could not resolve \"" + name + "\" plugin");
                        warnedPlugins[name] = true;
                        return;
                    }
                    if (!baseDirMatch) {
                        if (!warnedPlugins[name])
                            console.warn("[architect_resolver_worker] expected plugin to be in plugins/ dir");
                        warnedPlugins[name] = true;
                    }
                    if (path && baseDirMatch)
                        ternWorker.addFile(path, null, ternWorker._architect.currentOrigin);
                    if (!def)
                        return;
                    
                    importsVal.getProp(name).addType(def);
                    type.getProp(name).addType(def);
                });
            }
        });

        function getPath(name) {
            var result = architectPlugins["_" + name];
            if (!result)
                return;
            return baseDirMatch[1] + result + ".js";
        }
    }

    function isDependencyAssign(node, kind) {
        return node.left.type === "MemberExpression"
            && (node.left.object.name === "main" || node.left.object.name === "plugin")
            && node.left.property.name === kind
            && node.right.type === "ArrayExpression";
    }

    return {
        passes: {
            postInfer: onPostInfer
        }
    };
});

});
// dependencies
var _ = require('lomath')
var cons = require('./constrain')

/**
 * Wrapper for exporting the non-private functions.
 * @param {[type]} options [description]
 */
function Neo4jKB(options) {
  options = options || {};
  if (!_.has(options, 'NEO4J_AUTH')) {
    throw new Error("You must at least supply a NEO4J_AUTH: '<username>:<password>' JSON argument.")
  };
  this.options = options;
  this.query = require('./query')(options)

  // setting the exportable functions
  this.pushNode = pushNode
  this.addNode = addNode
  this.pullNode = pullNode
  this.getNode = getNode
  this.pushEdge = pushEdge
  this.addEdge = addEdge
  this.pullEdge = pullEdge
  this.getEdge = getEdge
  this.pull = pull
  this.get = get

  return this
}

module.exports = Neo4jKB


/////////////
// Helpers //
/////////////

/**
 * Parses prop JSON into a 'literal map' string as required by neo4j error (unable to user parameter map in MATCH).
 * @private
 * @param  {JSON} [prop] Object to parse.
 * @param  {string} [prop] Optional name for prop to use.
 * @return {string}      The result literal map string. Empty string is prop is falsy.
 *
 * @example
 * var prop = {name: 'A', hash_by: 'name'}
 * literalizeProp(prop)
 * // => {name: {prop}.name, hash_by: {prop}.hash_by, hash: {prop}.hash}
 * 
 * literalizeProp(prop, 'propA')
 * // => {name: {propA}.name, hash_by: {propA}.hash_by, hash: {propA}.hash}
 * 
 */
function literalizeProp(prop, propName) {
  if (!prop) {
    return ''
  };
  propName = propName || 'prop'
  var litArr = _.map(prop, function(v, k) {
    return k + ': {' + propName + '}.' + k
  })
  return ' {' + litArr.join(', ') + '}'
}

/**
 * Sort the array of prop-Label pair given with (prop, Label), or ([prop, Label]), where each is optional, into [[prop], [Label]]. Prop can also be a Dist string (startsWith '*') for edge.
 * @private
 * @param  {JSON, string|Array} prop-Label Separately as two arguments. Either is optional.
 * @param  {Array} propLabel Together in an array. Either is optional.
 * @return {Array}           Of sorted [[prop], [Label]], either can be empty.
 */
function sortPropLabel(propLabel) {
  return _.partition(_.flatten(arguments), function(arg) {
    // catch prop JSON, or *Dist string for edge
    return _.isPlainObject(arg) || _.startsWith(arg, '*')
  })
}

/**
 * Takes a parsed query-param pair Array, scan for '[e:l1:l2...]', split into a copy of the same pair for each label, with that label only.
 * @private
 * @param  {Array} qpPair query-param pair array, parsed for query.
 * @param  {Boolean} relaxELabel=false A boolean to relax the contraint where E must be labeled. Pass true to relax.
 * @return {Array}        Array of qpPair(s).
 *
 * @example
 * var propA = {name: 'A', hash_by: 'name'}
 * var propB = {name: 'B', hash_by: 'name'}
 * var labelA = 'alpha'
 * var labelB = 'alpha'
 * 
 * var propE = {name: 'lexicography', hash_by: 'name'}
 * cons.legalize(propE)
 * var labelE = ['next', 'after']
 *
 * var qpPair = pushEdge([propE, labelE], [propA, labelA], [propB, labelB]);
 * console.log(splitLabelE(qpPair))
 * // [ 
 * // [ 'MATCH (a:alpha {name: {propA}.name, hash_by: {propA}.hash_by}), (b:alpha {name: {propB}.name, hash_by: {propB}.hash_by}) MERGE (a)-[e:next {hash: {propE}.hash}]->(b) ON CREATE SET e = {propE}, e.created_by={propE}.updated_by, e.created_when={propE}.updated_when ON MATCH SET e += {propE} RETURN e', { propA: [Object], propB: [Object], propE: [Object] } ],
 * // [ 'MATCH (a:alpha {name: {propA}.name, hash_by: {propA}.hash_by}), (b:alpha {name: {propB}.name, hash_by: {propB}.hash_by}) MERGE (a)-[e:after {hash: {propE}.hash}]->(b) ON CREATE SET e = {propE}, e.created_by={propE}.updated_by, e.created_when={propE}.updated_when ON MATCH SET e += {propE} RETURN e', { propA: [Object], propB: [Object], propE: [Object] } ] 
 * // ]
 * 
 */
function splitLabelE(qpPair, relaxELabel) {
  var query = _.get(qpPair, 0),
    param = _.get(qpPair, 1)
  var matchELabel = query.match(/(?:\[e)(\:\S+)(\s+)/);
  // if no ELabel
  if (!matchELabel) {
    // if is relaxed, can be empty
    if (relaxELabel) {
      return [qpPair]
    } else {
      throw new Error("Edges (relationships) must have label(s).")
    }
  };

  // the extracted labelStr, then split into array
  var labelStr = matchELabel[1]
  var labelArr = _.trim(labelStr, ':').split(':');
  if (relaxELabel) {
    // if relaxed, combine existing labels with :label0|label1|...
    var orLabelStr = labelArr.join('|')
    var singleLabelQuery = query.replace(/(\[e)(\:\S+)(\s+)/, '$1' + cons.stringifyLabel(orLabelStr))
    return [
      [singleLabelQuery, param]
    ]
  } else {
    // the splitted result: same qpPair for each labelE
    return _.map(labelArr, function(labelStr) {
      var singleLabelQuery = query.replace(/(\[e)(\:\S+)(\s+)/, '$1' + cons.stringifyLabel(labelStr))
      return [singleLabelQuery, param]
    })
  }

}

// the first arg is an array, containing a (JSON || string) || (string || Arr of string) === JSON || string || Arr of string
/**
 * Check if an entity (inside an array) resides within a propDistLabel array. Check if it's JSON prop || string Dist || string Label || Array of >1 string labels
 * @private
 * @param  {*}  entity Inside a propDistLabel array
 * @return {Boolean}        true if entity is inside propDistLabel
 */
function isOfPropDistLabel(entity) {
  return _.isPlainObject(entity) || _.isString(entity) || (_.isArray(entity) && _.size(entity) > 1 && _.isString(entity[0]))
}
// console.log(isOfPropDistLabel({name: 'A'}))
// console.log(isOfPropDistLabel('*0..1'))
// console.log(isOfPropDistLabel('label'))
// console.log(isOfPropDistLabel(['label0', 'label1']))

/**
 * Check if an array is propDistLabel. Calls isOfPropDistLabel internally.
 * @private
 * @param  {Array}  array 
 * @return {Boolean}       true if so.
 */
function isPropDistLabel(array) {
  return _.prod(_.map(array, isOfPropDistLabel))
}
// console.log(isPropDistLabel([{name: 'A'}]))
// console.log(isPropDistLabel([{name: 'A'}, 'label']))
// console.log(isPropDistLabel([{name: 'A'}, ['label0', 'label1']]))
// console.log(isPropDistLabel(['*0..1', 'label']))
// console.log(isPropDistLabel(['label']))
// console.log(isPropDistLabel([['label0', 'label1']]))

/**
 * Returns the tensor rank of an argument array from the batchQuery arg tail.
 * @private
 * @param  {Array} tailArr The array of argument at the tail of arg of batchQuery.
 * @return {integer}         The rank, starting from 1.
 */
function getRank(tailArr) {
  if (isPropDistLabel(tailArr)) {
    return 0;
  } else {
    return 1 + getRank(_.first(tailArr));
  }
}
/**
 * Flatten an array to rank n. Basically flatten it for (getRank - n) times. If the original rank is lower, just return the array.
 * @private
 * @param  {Array} arr The array to flatten to rank n.
 * @param  {integer} n   Target rank to flatten to.
 * @return {Array}     The flattened (or not) array.
 */
function flattenToRank(arr, n) {
  var rankDiff = getRank(arr) - n
  if (rankDiff < 0) {
    return arr
  };
  while (rankDiff--) {
    arr = _.flatten(arr)
  }
  return arr
}
// var arr = [[[[{name: 'a'}]]]]
// console.log(flattenToRank(arr,  2))

//////////////////
// Node methods //
//////////////////

/**
 * The node batching function. Applies the tail arguments to the query-param composer function fn: (prop, Label) or ([prop0, Label0], [prop1, Label1], ...), then apply to a single query. Used to compose the high level KB_builder functions such as addNode, findNode etc.
 * @private
 * @param  {Function} fn     The function for composing a valid query-params Array for query() to take.
 * @param  {*}  single_query, As (fn, *, *, ...), e.g. (fn, prop, Label)
 * @param  {*}  multi_queries As (fn, [*], [*], [*]...), e.g. (fn, [prop0, Label0], [prop1, Label1], ...)
 * @param  {*}  multi_queries_one_array As (fn, [[*], [*], [*]...]), e.g. (fn, [[prop0, Label0], [prop1, Label1], ...])
 * @return {Promise}          From the query.
 *
 * @example
 * var addNode =  _.partial(batchNodeQuery, pushNode)
 * // => function to add node to KB.
 */
function batchNodeQuery(fn, prop, Label) {
  var tailArg = _.omit(arguments, 0);
  // if first arg is a prop obj, or is Label
  if (_.isPlainObject(prop) || _.isString(prop) || (_.isArray(prop) && _.isString(_.get(prop, 0)))) {
    return query(fn(..._.toArray(tailArg)))
  } else {
    // otherwise assume tailArg is arr of arg-arr
    // if it were {:[[], [], []...]}, tA = [[], [], []...]
    if (_.size(tailArg) == 1) {
      tailArg = _.get(tailArg, 1)
    };
    // First tailArg already {[], [], []...} =~ [[], [], []...]
    var argArr = _.map(tailArg, function(arr) {
      return fn(..._.toArray(arr))
    });
    // feed [[], [], []...] to query
    // then batch-apply all pairs to a single query
    return query(argArr)
  }
}

/**
 * Returns a query-param pair for addNode, taking a required non-empty JSON prop satisfying the KB constraints, and an optional Label string or array. This is used to inject the query-param pair into query.
 * @param {JSON} prop   Shallow JSON of key-value pairs; Must be legal: satisfies constraints imposed by constrain.js
 * @param {string|Array} Label A single string, or an array of strings that labels this node.
 * @return {Array} Pair of query-string and params JSON; or empty array if prop didn't pass the cons. By hashing, this will update the node if it already exists.
 */
function pushNode(prop, Label) {
  var labelStr = cons.stringifyLabel(Label)
  if (cons.pass(prop)) {
    return [
      // check existence, find by hash
      'MERGE (u' + labelStr + ' {hash: {prop}.hash}) ' +
      // create if no hash matched
      'ON CREATE SET u = {prop}, u.created_by={prop}.updated_by, u.created_when={prop}.updated_when ' +
      // update if hash matched
      'ON MATCH SET u += {prop} RETURN u', {
        prop: prop
      }
    ]
  } else {
    return []
  }
}

/**
 * Adds node(s) to neo4j with a required JSON prop satisfying the KB constraints, and an optional Label string or array.
 * @param  {*}  single_query, As (fn, *, *, ...), e.g. (fn, prop, Label)
 * @param  {*}  multi_queries As (fn, [*], [*], [*]...), e.g. (fn, [prop0, Label0], [prop1, Label1], ...)
 * @param  {*}  multi_queries_one_array As (fn, [[*], [*], [*]...]), e.g. (fn, [[prop0, Label0], [prop1, Label1], ...])
 * @return {Promise}          From the query.
 *
 * @example
 * var propA = {name: 'A', hash_by: 'name'}
 * var propB = {name: 'B', hash_by: 'name'}
 * // legalize the prop objects subject to constraints
 * cons.legalize(propA)
 * cons.legalize(propB)

 * addNode(propA, 'alpha').then(_.flow(JSON.stringify, console.log))
 * // {"results":[{"columns":["u"],"data":[{"row":[{"created_when":1452801392345,"updated_by":"tester","name":"A","hash_by":"name","created_by":"tester","hash":"A","updated_when":1452802417919}]}]}],"errors":[]}
 * // The node is added/updated to KB.
 *
 * // batch node query by array of pairs
 * addNode([propA, 'alpha'], [propB, 'alpha']).then(_.flow(JSON.stringify, console.log))
 * 
 * // equivalently
 * addNode([[propA, 'alpha'], [propB, 'alpha']]).then(_.flow(JSON.stringify, console.log))
 * // {"results":[{"columns":["u"],"data":[{"row":[{"created_when":1452801392345,"updated_by":"tester","name":"A","hash_by":"name","created_by":"tester","hash":"A","updated_when":1452803465461}]}]},{"columns":["u"],"data":[{"row":[{"created_when":1452803465462,"name":"B","updated_by":"tester","hash_by":"name","created_by":"tester","hash":"B","updated_when":1452803465462}]}]}],"errors":[]}
 * // propA node is updated; propB node is added.
 * 
 */
var addNode = _.partial(batchNodeQuery, pushNode)


// var propA = {name: 'A', hash_by: 'name'}
// var propB = {name: 'B', hash_by: 'name'}
// cons.legalize(propA)
// cons.legalize(propB)
// addNode(propA, 'alpha').then(_.flow(JSON.stringify, console.log))
// addNode([propA, 'alpha'], [propB, 'alpha']).then(_.flow(JSON.stringify, console.log))
// addNode([[propA, 'alpha'], [propB, 'alpha']]).then(_.flow(JSON.stringify, console.log))


/**
 * The symmetric counterpart of pushNode. Returns a query-param pair for getNode, taking a required non-empty JSON prop (does not need to satisfy constraints), and an optional Label string or array. This is used to inject the query-param pair into query.
 * @param {JSON} prop   Shallow JSON of key-value pairs; must satisfy constraints imposed by constrain.js
 * @param {string|Array} Label A single string, or an array of strings that labels this node.
 * @return {Array} Pair of query-string and params JSON.
 */
function pullNode(prop, Label) {
  var part = sortPropLabel(...arguments)
  prop = _.get(part, '0.0')
  Label = _.get(part, '1.0')

  var labelStr = cons.stringifyLabel(Label)
  return ['MATCH (u' + labelStr + literalizeProp(prop) + ') RETURN u', _.pickBy({
    prop: prop
  })]
}

/**
 * Get node(s) from neo4j with JSON prop, and optional Label.
 * @param  {*}  single_query, As (fn, *, *, ...), e.g. (fn, prop, Label)
 * @param  {*}  multi_queries As (fn, [*], [*], [*]...), e.g. (fn, [prop0, Label0], [prop1, Label1], ...)
 * @param  {*}  multi_queries_one_array As (fn, [[*], [*], [*]...]), e.g. (fn, [[prop0, Label0], [prop1, Label1], ...])
 * @return {Promise}          From the query.
 *
 * @example
 * var prop2 = {name: 'A', hash_by: 'name'}
 * var prop3 = {name: 'B', hash_by: 'name'}
 * // no constrain needed when getting node from KB
 *
 * get nodes from just the prop
 * getNode(prop2).then(_.flow(JSON.stringify, console.log))
 * // {"results":[{"columns":["u"],"data":[{"row":[{"created_when":1452807183847,"updated_by":"bot","name":"A","hash_by":"name","created_by":"tester","hash":"A","updated_when":1453244315302}]}]}],"errors":[]}
 *
 * get nodes from just the label
 * getNode('alpha').then(_.flow(JSON.stringify, console.log))
 * // {"results":[{"columns":["u"],"data":[{"row":[{"created_when":1452807183847,"updated_by":"bot","name":"A","hash_by":"name","created_by":"tester","hash":"A","updated_when":1453244315302}]},{"row":[{"created_when":1452807183848,"updated_by":"bot","name":"B","hash_by":"name","created_by":"tester","hash":"B","updated_when":1453244315304}]},{"row":[{"created_when":1453143013572,"updated_by":"bot","name":"C","hash_by":"name","created_by":"bot","hash":"C","updated_when":1453143013572}]}]}],"errors":[]}
 * 
 * // get nodes from a propLabel pair
 * getNode(prop2, 'alpha').then(_.flow(JSON.stringify, console.log))
 * // {"results":[{"columns":["u"],"data":[{"row":[{"created_when":1452801392345,"updated_by":"tester","name":"A","hash_by":"name","created_by":"tester","hash":"A","updated_when":1452803465461}]}]}],"errors":[]}
 *
 * // get nodes from many propLabel pairs
 * getNode([prop2, 'alpha'], [prop3, 'alpha']).then(_.flow(JSON.stringify, console.log))
 * // equivalently
 * getNode([[prop2, 'alpha'], [prop3, 'alpha']]).then(_.flow(JSON.stringify, console.log))
 * // {"results":[{"columns":["u"],"data":[{"row":[{"created_when":1452801392345,"updated_by":"tester","name":"A","hash_by":"name","created_by":"tester","hash":"A","updated_when":1452803465461}]}]},{"columns":["u"],"data":[{"row":[{"created_when":1452803465462,"updated_by":"tester","name":"B","hash_by":"name","created_by":"tester","hash":"B","updated_when":1452803465462}]}]}],"errors":[]}
 * 
 */
var getNode = _.partial(batchNodeQuery, pullNode)


// prop2 = {
//   name: 'A',
//   hash_by: 'name'
// }
// prop3 = {
//   name: 'B',
//   hash_by: 'name'
// }
// getNode(prop2).then(_.flow(JSON.stringify, console.log))
// getNode('alpha').then(_.flow(JSON.stringify, console.log))
// getNode(prop2, 'alpha').then(_.flow(JSON.stringify, console.log))
// getNode([prop2, 'alpha'], [prop3, 'alpha']).then(_.flow(JSON.stringify, console.log))
// getNode([[prop2, 'alpha'], [prop3, 'alpha']]).then(_.flow(JSON.stringify, console.log))



//////////////////
// Edge methods //
//////////////////

/**
 * The edge batching function. Applies the tail arguments to the query-param composer function fn: (propLabelE, propLabelA, propLabelB) or ([triple], [triple], ...), then apply to a single query. Used to compose the high level KB_builder functions such as addEdge, findEdge etc.
 * Internally calls the splitLabelE function to generate more query-param pairs which only single Elabels, since each edge can contain only a label.
 * @private
 * @param  {Function} fn     The function for composing a valid query-params Array for query() to take.
 * @param  {*}  single_query, As (fn, *, *, ...), e.g. (fn, propLabelE, propLabelA, propLabelB)
 * @param  {*}  multi_queries As (fn, [*], [*], [*]...), e.g. (fn, [propLabelE0, propLabelA0, propLabelB0], [propLabelE1, propLabelA1, propLabelB1], ...)
 * @param  {*}  multi_queries_one_array As (fn, [[*], [*], [*]...]), e.g. (fn, [[propLabelE0, propLabelA0, propLabelB0], [propLabelE1, propLabelA1, propLabelB1], ...])
 * @return {Promise}          From the query.
 *
 * @example
 * var addEdge =  _.partial(batchEdgeQuery, pushEdge)
 * // => function to add edge to KB.
 */
function batchEdgeQuery(fn, propLabelE, propLabelA, propLabelB) {
  var tailArr = _.tail(_.toArray(arguments));
  // determine the rank of T
  var rank = getRank(tailArr);
  // properly ranked argArr to pass to query at the end
  var argArr;
  // construct the argArr by rank; applies fn and splitLabelE
  if (rank > 1) {
    // flatten all higher to rank 2
    tailArr = flattenToRank(tailArr, 2)
    argArr = _.flatten(_.map(tailArr, function(arr) {
      // here relaxing the ELabel constraint
      return splitLabelE(fn(...arr))
    }))
  } else if (rank == 1) {
    argArr = splitLabelE(fn(...tailArr))
  } else {
    throw new Error("Your argument rank is < 1. Rank must be > 0.")
  }
  // console.log(argArr);
  return query(argArr)
}

/**
 * Returns a query-param pair for addEdge, taking propLabels of nodes A -> B with the edge E. The propLabel for A and B is an array of a optional non-empty JSON prop (doesn't have to satisfy KB constraints), and an optional Label string or array. The prop for E must satisfy the KB constraints, and the Label for E is required. This is used to inject the query-param pair into query.
 * @param {Array} propLabelE   propLabel pair of target node B. Must be legal.
 * @param {Array} propLabelA   propLabel pair of source node A. Doesn't need to be legal - the same as used in getNode.
 * @param {Array} propLabelB   propLabel pair of target node B. Doesn't need to be legal - the same as used in getNode.
 * @return {Array} Pair of query and params object; or empty array if prop didn't pass the cons. By hashing, this will update the edge if it already exists.
 */
function pushEdge(propLabelE, propLabelA, propLabelB) {
  // edge, needs to pass cons
  var partE = sortPropLabel(propLabelE),
    propE = _.get(partE, '0.0'),
    LabelE = _.get(partE, '1.0'),
    LabelStrE = cons.stringifyLabel(LabelE);
  // nodes, dont need to pass cons
  var partA = sortPropLabel(propLabelA),
    propA = _.get(partA, '0.0'),
    LabelA = _.get(partA, '1.0'),
    LabelStrA = cons.stringifyLabel(LabelA);
  var partB = sortPropLabel(propLabelB),
    propB = _.get(partB, '0.0'),
    LabelB = _.get(partB, '1.0'),
    LabelStrB = cons.stringifyLabel(LabelB);

  if (cons.pass(propE)) {
    return [
      // a and b nodes must already exist
      'MATCH (a' + LabelStrA + literalizeProp(propA, 'propA') + '), (b' + LabelStrB + literalizeProp(propB, 'propB') + ') ' +
      // check if e already exists by propE hash
      'MERGE (a)-[e' + LabelStrE + '{hash: {propE}.hash}]->(b) ' +
      // create if no hash matched
      'ON CREATE SET e = {propE}, e.created_by={propE}.updated_by, e.created_when={propE}.updated_when ' +
      // update if hash matched
      'ON MATCH SET e += {propE} RETURN e', {
        propE: propE,
        propA: propA,
        propB: propB
      }
    ]
  } else {
    return []
  }
}

/**
 * Adds edge(s) to neo4j with propLabel of nodes A -> B with the edge E. The propLabel for A and B is an array of a optional non-empty JSON prop (doesn't have to satisfy KB constraints), and an optional Label string or array. The prop for E must satisfy the KB constraints, and the Label for E is required.
 * @param  {*}  single_query, As (fn, *, *, ...), e.g. (fn, propLabelE, propLabelA, propLabelB)
 * @param  {*}  multi_queries As (fn, [*], [*], [*]...), e.g. (fn, [propLabelE0, propLabelA0, propLabelB0], [propLabelE1, propLabelA1, propLabelB1], ...)
 * @param  {*}  multi_queries_one_array As (fn, [[*], [*], [*]...]), e.g. (fn, [[propLabelE0, propLabelA0, propLabelB0], [propLabelE1, propLabelA1, propLabelB1], ...])
 * @return {Promise}          From the query.
 *
 * @example
 * var propE = {name: 'lexicography', hash_by: 'name'}
 * cons.legalize(propE)
 * var labelE = 'next'
 * var labelE2 = 'after'
 * var labelEArr = ['next', 'after']
 * 
 * var propA = {name: 'A', hash_by: 'name'}
 * var propB = {name: 'B', hash_by: 'name'}
 * var labelA = 'alpha'
 * var labelB = 'alpha'
 *
 * // add edge E from node A to node B
 * addEdge([propE, labelE], [propA, labelA], [propB, labelB]).then(_.flow(JSON.stringify, console.log))
 * // {"results":[{"columns":["e"],"data":[{"row":[{"created_when":1452825908415,"updated_by":"bot","name":"lexicography","hash_by":"name","created_by":"tester","hash":"lexicography","updated_when":1452884323471}]}]},{"columns":["e"],"data":[{"row":[{"created_when":1452884323471,"name":"lexicography","updated_by":"bot","hash_by":"name","created_by":"bot","hash":"lexicography","updated_when":1452884323471}]}]}],"errors":[]}
 * // The edge labeled 'next' is added/updated to KB.
 *
 * Constraints only for propE, required Label for edge E. No constraints or requirements for nodes A and B.
// addEdge([propE, labelE], [labelA], [propB, labelB]).then(_.flow(JSON.stringify, console.log))
 * // {"results":[{"columns":["e"],"data":[{"row":[{"created_when":1452825908415,"updated_by":"bot","name":"lexicography","hash_by":"name","created_by":"tester","hash":"lexicography","updated_when":1453259876938}]},{"row":[{"created_when":1453259876938,"name":"lexicography","updated_by":"bot","hash_by":"name","created_by":"bot","hash":"lexicography","updated_when":1453259876938}]},{"row":[{"created_when":1453259876938,"name":"lexicography","updated_by":"bot","hash_by":"name","created_by":"bot","hash":"lexicography","updated_when":1453259876938}]}]}],"errors":[]}
 * 
 * // batch edge query by array of pairs
 * addEdge(
 * [ [propE, labelE], [propA, labelA], [propB, labelB] ], 
 * [ [propE, labelE2], [propA, labelA], [propB, labelB] ]
 * ).then(_.flow(JSON.stringify, console.log))
 * 
 * // equivalently
 * addEdge([
 * [ [propE, labelE], [propA, labelA], [propB, labelB] ], 
 * [ [propE, labelE2], [propA, labelA], [propB, labelB] ]
 * ]).then(_.flow(JSON.stringify, console.log))
 * // {"results":[{"columns":["e"],"data":[{"row":[{"created_when":1452825908415,"updated_by":"bot","name":"lexicography","hash_by":"name","created_by":"tester","hash":"lexicography","updated_when":1452884568091}]}]},{"columns":["e"],"data":[{"row":[{"created_when":1452884323471,"updated_by":"bot","name":"lexicography","hash_by":"name","created_by":"bot","hash":"lexicography","updated_when":1452884568091}]}]}],"errors":[]}
 * // edge 'next' is updated, edge 'after' is added
 *
 * shorthand for edge with multiple labels but same prop
 * addEdge([propE, labelEArr], [propA, labelA], [propB, labelB]).then(_.flow(JSON.stringify, console.log))
 * // {"results":[{"columns":["e"],"data":[{"row":[{"created_when":1452825908415,"updated_by":"bot","name":"lexicography","hash_by":"name","created_by":"tester","hash":"lexicography","updated_when":1452884620930}]}]},{"columns":["e"],"data":[{"row":[{"created_when":1452884323471,"updated_by":"bot","name":"lexicography","hash_by":"name","created_by":"bot","hash":"lexicography","updated_when":1452884620930}]}]}],"errors":[]}
 * 
 */
var addEdge = _.partial(batchEdgeQuery, pushEdge)


// var propE = {name: 'lexicography', hash_by: 'name'}
// cons.legalize(propE)
// var labelE = 'next'
// var labelE2 = 'after'
// var labelEArr = ['next', 'after']

// var propA = {name: 'A', hash_by: 'name'}
// var propB = {name: 'B', hash_by: 'name'}
// var labelA = 'alpha'
// var labelB = 'alpha'

// console.log(splitLabelE(pushEdge([propE, labelE], [propA, labelA], [propB, labelB])))

// addEdge([propE, labelEArr], [propA, labelA], [propB, labelB]).then(_.flow(JSON.stringify, console.log))
// addEdge([propE, labelE], [labelA], [propB, labelB]).then(_.flow(JSON.stringify, console.log))

// addEdge(
// [ [propE, labelE], [propA, labelA], [propB, labelB] ], 
// [ [propE, labelE2], [propA, labelA], [propB, labelB] ]
// ).then(_.flow(JSON.stringify, console.log))

// addEdge([
// [ [propE, labelE], [propA, labelA], [propB, labelB] ], 
// [ [propE, labelE2], [propA, labelA], [propB, labelB] ]
// ]).then(_.flow(JSON.stringify, console.log))

// addEdge([propE, labelEArr], [propA, labelA], [propB, labelB]).then(_.flow(JSON.stringify, console.log))



/**
 * The symmetric counterpart to pushEdge. Returns a query-param pair for getEdge, taking propLabels of nodes A -> B with the edge E. The propLabel for A, B and E is an array of a optional non-empty JSON prop (doesn't have to satisfy KB constraints), and an optional Label string or array. This is used to inject the query-param pair into query.
 * @param {Array} propLabelE   propLabel pair of edge E; either is optional. Doesn't need to be legal.
 * @param {Array} [propLabelA]   Optional propLabel pair of source node A. Doesn't need to be legal.
 * @param {Array} [propLabelB]   Optional propLabel pair of target node B. Doesn't need to be legal.
 * @return {Array} Pair of query and params object.
 */
function pullEdge(propLabelE, propLabelA, propLabelB) {
  // edge, does not need pass cons
  var partE = sortPropLabel(propLabelE),
    propE = _.get(partE, '0.0'),
    LabelE = _.get(partE, '1.0'),
    LabelStrE = cons.stringifyLabel(LabelE);
  // nodes, dont need to pass cons
  var partA = sortPropLabel(propLabelA),
    propA = _.get(partA, '0.0'),
    LabelA = _.get(partA, '1.0'),
    LabelStrA = cons.stringifyLabel(LabelA);
  var partB = sortPropLabel(propLabelB),
    propB = _.get(partB, '0.0'),
    LabelB = _.get(partB, '1.0'),
    LabelStrB = cons.stringifyLabel(LabelB);

  return [
    'MATCH (a' + LabelStrA + literalizeProp(propA, 'propA') + ')' +
    '-[e' + LabelStrE + literalizeProp(propE, 'propE') + ']->' +
    '(b' + LabelStrB + literalizeProp(propB, 'propB') + ') ' +
    'RETURN e', _.pickBy({
      propE: propE,
      propA: propA,
      propB: propB
    })
  ]
}

/**
 * Get edge(s) from neo4j with propLabel of nodes A -> B with the edge E. The propLabel for A, B and E is an array of a optional non-empty JSON prop (doesn't have to satisfy KB constraints), and a (optional for A,B; required for E) Label string or array.
 * @param  {*}  single_query, As (fn, *, *, ...), e.g. (fn, propLabelE, propLabelA, propLabelB)
 * @param  {*}  multi_queries As (fn, [*], [*], [*]...), e.g. (fn, [propLabelE0, propLabelA0, propLabelB0], [propLabelE1, propLabelA1, propLabelB1], ...)
 * @param  {*}  multi_queries_one_array As (fn, [[*], [*], [*]...]), e.g. (fn, [[propLabelE0, propLabelA0, propLabelB0], [propLabelE1, propLabelA1, propLabelB1], ...])
 * @return {Promise}          From the query.
 *
 * @example
 * var propE = {name: 'lexicography', hash_by: 'name'}
 * var labelE = 'next'
 * var labelE2 = 'after'
 * var labelEArr = ['next', 'after']
 * 
 * var propA = {name: 'A', hash_by: 'name'}
 * var propB = {name: 'B', hash_by: 'name'}
 * var labelA = 'alpha'
 * var labelB = 'alpha'
 *
 * // The below are equivalent for the added edge above, and show that propLabelA and propLabelB are optional.
 * getEdge(
 *  [propE, labelE]
 *  ).then(_.flow(JSON.stringify, console.log))
 * 
 * getEdge(
 *  [propE, labelE],
 *  [propA, labelA]
 *  ).then(_.flow(JSON.stringify, console.log))
 *
 * // label is required for E; The rest are optional.
 * getEdge(
 *  [labelE],
 *  [propA]
 *  ).then(_.flow(JSON.stringify, console.log))
 * // {"results":[{"columns":["e"],"data":[{"row":[{"created_when":1453143189686,"updated_by":"bot","name":"lexicography","hash_by":"name","created_by":"bot","hash":"lexicography","updated_when":1453143189686}]},{"row":[{"created_when":1452825908415,"updated_by":"bot","name":"lexicography","hash_by":"name","created_by":"tester","hash":"lexicography","updated_when":1453259876938}]}]}],"errors":[]}
 * 
 * getEdge(
 *  [propE, labelE],
 *  [propA, labelA],
 *  [propB, labelB]
 *  ).then(_.flow(JSON.stringify, console.log))
 * // {"results":[{"columns":["e"],"data":[{"row":[{"created_when":1452825908415,"updated_by":"bot","name":"lexicography","hash_by":"name","created_by":"tester","hash":"lexicography","updated_when":1452885949550}]}]}],"errors":[]}
 *
 *
 * // the following are equivalent: batch edge query
 * getEdge(
 *  [[propE, labelE] ],
 *  [[propE, labelE2] ]
 *  ).then(_.flow(JSON.stringify, console.log))
 * getEdge([
 *  [[propE, labelE] ],
 *  [[propE, labelE2] ]
 * ]).then(_.flow(JSON.stringify, console.log))
 * // {"results":[{"columns":["e"],"data":[{"row":[{"created_when":1452825908415,"updated_by":"bot","name":"lexicography","hash_by":"name","created_by":"tester","hash":"lexicography","updated_when":1452885949550}]}]},{"columns":["e"],"data":[{"row":[{"created_when":1452884323471,"updated_by":"bot","name":"lexicography","hash_by":"name","created_by":"bot","hash":"lexicography","updated_when":1452885949550}]}]}],"errors":[]}
 *
 * // shorthand: pull multiple edges using multiple labels, and same prop.
 * getEdge(
 *  [propE, labelEArr]
 *  ).then(_.flow(JSON.stringify, console.log))
 * // {"results":[{"columns":["e"],"data":[{"row":[{"created_when":1452825908415,"updated_by":"bot","name":"lexicography","hash_by":"name","created_by":"tester","hash":"lexicography","updated_when":1452885949550}]}]},{"columns":["e"],"data":[{"row":[{"created_when":1452884323471,"updated_by":"bot","name":"lexicography","hash_by":"name","created_by":"bot","hash":"lexicography","updated_when":1452885949550}]}]}],"errors":[]}
 * 
 */
var getEdge = _.partial(batchQuery, pullEdge)


// var propE = {
//   name: 'lexicography',
//   hash_by: 'name'
// }
// var labelE = 'next'
// var labelE2 = 'after'
// var labelEArr = ['next', 'after']

// var propA = {
//   name: 'A',
//   hash_by: 'name'
// }
// var propB = {
//   name: 'B',
//   hash_by: 'name'
// }
// var labelA = 'alpha'
// var labelB = 'alpha'

// console.log(pullEdge(
//  [propE, labelE]
//  ))

// getEdge(
//  [propE, labelE]
//  ).then(_.flow(JSON.stringify, console.log))

// getEdge(
//  [propE, labelE],
//  [propA, labelA]
//  ).then(_.flow(JSON.stringify, console.log))

// getEdge(
//  [labelE],
//  [propA]
//  ).then(_.flow(JSON.stringify, console.log))

// getEdge(
//  [propE, labelE],
//  [propA, labelA],
//  [propB, labelB]
//  ).then(_.flow(JSON.stringify, console.log))


// getEdge(
//  [[propE, labelE] ],
//  [[propE, labelE2] ]
//  ).then(_.flow(JSON.stringify, console.log))
// getEdge([
//  [[propE, labelE] ],
//  [[propE, labelE2] ]
//  ]).then(_.flow(JSON.stringify, console.log))


// getEdge(
//  [propE, labelEArr]
//  ).then(_.flow(JSON.stringify, console.log))


///////////////////
// Graph methods //
///////////////////



/**
 * The graph (node and edge) batching function. Applies the tail arguments to the query-param composer function fn: (propLabelA, propDistLabelE, propLabelB, wOp, sOp, rOp, pOp) or ([7-tuple], [7-tuple], ...), or ([[7-tuple], [7-tuple], ...]), then apply to a single query. Used to compose the high level KB_builder functions such as get etc.
 * Internally calls the splitLabelE (LabelE relaxed - not required) function to generate more query-param pairs which only single Elabels, since each edge can contain only a label. Applies fn by the argument tensor rank: either rank-1 or rank-2 and above (reduced to rank-2 and apply). Rank-1: ([p, L], [p|D, L], [p, L], wOp, rOp).
 * @private
 * @param  {Function} fn     The function for composing a valid query-params Array for query() to take.
 * @param  {*}  single_query, As (fn, *, *, ...), e.g. (fn, [p, L], [p|D, L], [p, L], wOp, rOp)
 * @param  {*}  multi_queries As (fn, [*], [*], [*]...), e.g. (fn, [[p, L], [p|D, L], [p, L], wOp, rOp], [[p, L], [p|D, L], [p, L], wOp, rOp], ...)
 * @param  {*}  multi_queries_one_array As (fn, [[*], [*], [*]...]), e.g. (fn, [[[p, L], [p|D, L], [p, L], wOp, rOp], [[p, L], [p|D, L], [p, L], wOp, rOp], ...])
 * @return {Promise}          From the query.
 *
 * @example
 * var get =  _.partial(batchQuery, pull)
 * // => function to get nodes and edges from KB.
 */
function batchQuery(fn, T) {
  var tailArr = _.tail(_.toArray(arguments));
  // determine the rank of T
  var rank = getRank(tailArr);
  // properly ranked argArr to pass to query at the end
  var argArr;
  // construct the argArr by rank; applies fn and splitLabelE
  if (rank > 1) {
    // flatten all higher to rank 2
    tailArr = flattenToRank(tailArr, 2)
    argArr = _.flatten(_.map(tailArr, function(arr) {
      // here relaxing the ELabel constraint
      return splitLabelE(fn(...arr), true)
    }))
  } else if (rank == 1) {
    argArr = splitLabelE(fn(...tailArr), true)
  } else {
    throw new Error("Your argument rank is < 1. Rank must be > 0.")
  }
  // console.log(argArr);
  return query(argArr)
}


// // a rank 1 arguments. 
// // Get only node(s)
// batchQuery(pull, [{
//   name: 'A'
// }, 'alpha'], 'RETURN a')

// // a rank 1 arguments. 
// // Get nodes and edges. Note that labelE is optional now
// batchQuery(pull, [{
//   name: 'A'
// }, 'alpha'], ['*0..1'], 'RETURN b,e')

// // a rank 2 arguments
// // Get nodes and edges
// batchQuery(pull, [
//   [{
//     name: 'A'
//   }, 'alpha'],
//   ['*0..1', 'next'], 'RETURN b,e'
// ])

// // a rank 3 arguments, practically the highest or you're using it wrong. Properly split by LabelE too
// batchQuery(pull, [
//   [
//     [{
//       name: 'A'
//     }, 'alpha'],
//     ['*0..1', ['next', 'xiage']], 'RETURN b,e'
//   ],
//   [
//     [{
//       name: 'B'
//     }, 'alpha'],
//     ['next'], 'RETURN b,e'
//   ]
// ])


/**
 * Returns a query-param pair for get, with string-cleaning (prevents SQL injection). This is a flexible method used for querying node(s), or optionally edge(s) and node(s). It also takes an optional WHERE filter sentence string, and a required RETURN sentence string. This is used to inject the query-param pair into query. The resultant query string is of the form:
 * For nodes: MATCH (a:LabelA {propA}) <wOp> <sOp> <rOp>
 * For nodes and edges: MATCH (a:LabelA {propA})-[e:LabelE ({propE}|*Dist)]-(b:LabelB {propB}) <wOp> <sOp> <rOp> <pOp>
 *
 * prop is the property JSON
 * Label is the label string or array of strings
 * Dist is the distance statement for edge; it is mutex with prop for edge.
 * <wOp> is the optional WHERE filter sentence, e.g. WHERE a.name="A" AND b.name="B"
 * <sOp> is the optional SET|REMOVE property-update sentence, e.g. SET a.age=10, a.sex="M"
 * <rOp> is the required RETURN|DELETE|DETACH DELETE sentence, e.g. RETURN b.hash, a.name; or DETACH DELETE a
 * <pOp> is the optional SHORETSTPATH|ALLSHORTESTPATHS sentence (no arguments), e.g. SHORTESTPATH
 * Note that the <Ops> can be specified at the tail of argument in any order since there is no ambiguity.
 * 
 * The entity names 'a', 'e', 'b' respectively from (a)-[e]->(b) must be specified in the <wOp>, <sOp> and <rOp> for correct reference, e.g. RETURN a.name. Also note the direction of the edge is from 'a'->'b'
 * If a <pOp> of SHORTESTPATH|ALLSHORTESTPATH, then 'p' references the path object.
 * 
 * For the edge e, either supply:
 * a JSON propE like {name="E"} for [e:LabelE {propE}] or,
 * a string Dist like '*0..2' for [e:LabelE *0..2]
 * this is because the two are already mutex in neo4j.
 * When <pOp> is used, propE is forbidden.
 * 
 * @private
 * @param  {Array} propLabelA     The propLabel pair for node 'a'. The second argument (LabelA) is optional.
 * @param  {Array} [propDistLabelE] The optional propLabel or distLabel pair for edge 'e'. The second argument (LabelE) is optional.
 * @param  {Array} [propLabelB]     The optional propLabel pair for node 'b'. The second argument (LabelB) is optional.
 * @param  {string} [wOp]            An optional, valid WHERE ... filter sentence.
 * @param  {string} [sOp]            An optional, valid SET|REMOVE ... property update sentence.
 * @param  {string} rOp            A required, valid RETURN|DELETE|DETACH DELETE ... return or delete sentence.
 * @param  {string} [pOp]            An optional SHORTESTPATH|ALLSHORTESTPATHS sentence to make the query return a path object 'p'.
 * @return {Array}                Pair of query and params object.
 *
 * @example
 * 
 * // return all nodes
 * console.log(pull([], 'RETURN a'))
 *   // [ 'MATCH (a ) RETURN a', {} ]
 *   
 * // return nodes with the prop
 * console.log(pull([{
 *     name: "A"
 *   }], 'RETURN a'))
 *   // [ 'MATCH (a {name: {propA}.name}) RETURN a', { propA: { name: 'A' } } ]
 *   
 * // return nodes with the prop
 * console.log(pull([{
 *     name: "A"
 *   }], 'RETURN a'))
 *   // [ 'MATCH (a {name: {propA}.name}) RETURN a', { propA: { name: 'A' } } ]
 *   
 * // return all nodes with the prop and label
 * console.log(pull([{
 *     name: "A"
 *   }, 'alpha'], 'RETURN a'))
 *   // [ 'MATCH (a:alpha {name: {propA}.name}) RETURN a', { propA: { name: 'A' } } ]
 *   
 * // same as above
 * console.log(pull([, 'alpha'], 'WHERE a.name="A"', 'RETURN a'))
 *   // [ 'MATCH (a:alpha ) where a.name="A" RETURN a', {} ]
 *   
 * // DETACH DELETE a node
 * console.log(pull([, 'alpha'], 'WHERE a.name="C"', 'DETACH DELETE a'))
 *   // [ 'MATCH (a ) where a.name="C" DETACH DELETE a', {} ]
 *   
 * // SET properties
 * console.log(pull(['alpha'], 'WHERE a.name="A"', 'SET a.age=10, a.sex="M"', 'RETURN a'))
 *   // [ 'MATCH (a:alpha ) where a.name="A" SET a.age=10, a.sex="M" RETURN a', {} ]
 *   
 * // REMOVE properties
 * console.log(pull(['alpha'], 'WHERE a.name="A"', 'REMOVE a.age, a.sex', 'RETURN a'))
 *   // [ 'MATCH (a:alpha ) where a.name="A" REMOVE a.age, a.sex RETURN a', {} ]
 *
 * 
 * // SHORTESTPATH return paths of: nodes and edges 0-2 units apart FROM node a, with the props and labels
 * console.log(pull([{
 *     name: 'A'
 *   }, 'alpha'], ['*0..2'], 'SHORTESTPATH', 'RETURN p, DISTINCT(nodes(p))'))
 *   // [ 'MATCH (a:alpha {name: {propA}.name})-[e:next *0..1]->(b )   return b,e', { propA: { name: 'A' } } ]
 *   
 * // return nodes and edges 0-1 units apart FROM node a, with the props and labels
 * console.log(pull([{
 *     name: 'A'
 *   }, 'alpha'], ['*0..1', 'next'], 'RETURN b,e'))
 *   // [ 'MATCH (a:alpha {name: {propA}.name})-[e:next *0..1]->(b )   return b,e', { propA: { name: 'A' } } ]
 *   
 * // return nodes and edges 0-1 units apart TO node B, with the props and labels
 * console.log(pull([], ['*0..1', 'next'], [{
 *     name: 'B'
 *   }, 'alpha'], 'RETURN a,e'))
 *   // [ 'MATCH (a )-[e:next *0..1]->(b:alpha {name: {propB}.name})   return a,e', { propB: { name: 'B' } } ]
 *   
 * // return nodes and edges units apart TO node B, with edge named 'E' and labeled 'next'
 * console.log(pull([], [{
 *     name: 'E'
 *   }, 'next'], [{
 *     name: 'B'
 *   }, 'alpha'], 'RETURN a,e'))
 *   // [ 'MATCH (a )-[e:next {name: {propE}.name}]->(b:alpha {name: {propB}.name})   return a,e', { propE: { name: 'E' }, propB: { name: 'B' } } ]
 *   
 * // same as above, but source nodes must now have name that is lexicographically lower than "B"
 * console.log(pull([], [{
 *     name: 'E'
 *   }, 'next'], [{
 *     name: 'B'
 *   }, 'alpha'], 'WHERE a.name < "B"', 'RETURN a,e'))
 *   // [ 'MATCH (a )-[e:next {name: {propE}.name}]->(b:alpha {name: {propB}.name})  WHERE a.name < "B" return a,e', { propE: { name: 'E' }, propB: { name: 'B' } } ]
 *   
 */
function pull(propLabelA, propDistLabelE, propLabelB, wOp, sOp, rOp, pOp) {
  // partition into arr and str arguments
  var part = _.partition(arguments, _.isArray)
  var arrArr = _.first(part),
    strArr = _.last(part);

  // setting args accordingly
  var propLabelA = arrArr[0],
    propDistLabelE = arrArr[1],
    propLabelB = arrArr[2];
  // the WHERE, SET, RETURN clauses
  var wOpStr = _.find(strArr, cons.isWOp) || '';
  var sOpStr = _.find(strArr, cons.isSOp) || '';
  var rOpStr = _.find(strArr, cons.isROp) || '';
  var pOpStr = _.find(strArr, cons.isPOp) || '';

  // console.log('propLabelA', propLabelA)
  // console.log('propDistLabelE', propDistLabelE)
  // console.log('propLabelB', propLabelB)
  // console.log("wOpStr", wOpStr)
  // console.log("sOpStr", sOpStr)
  // console.log("rOpStr", rOpStr)
  // console.log("pOpStr", pOpStr)

  // declare the head, body, tail of the query string, and the props
  // head = MATCH (a:LabelA {propA})
  // body = -[e:LabelE {propE}|*Dist]->(b:LabelB {propB})
  // tail = WHERE ... SET|REMOVE ... RETURN|DELETE|DETACH DELETE ...
  var head, body, tail, props;

  // Head: first node arg
  var partA = sortPropLabel(propLabelA),
    propA = _.get(partA, '0.0'),
    LabelA = _.get(partA, '1.0'),
    LabelStrA = cons.stringifyLabel(LabelA);
  head = 'MATCH (a' + LabelStrA + literalizeProp(propA, 'propA') + ')'

  // Body: optional edge and end node args
  if (propDistLabelE) {
    // edge, doesn't need to pass cons
    var partE = sortPropLabel(propDistLabelE),
      propDistE = _.get(partE, '0.0'),
      // take prop XOR dist for edge
      propE = _.isPlainObject(propDistE) ? propDistE : undefined,
      distE = cons.stringifyDist(propDistE),
      LabelE = _.get(partE, '1.0'),
      LabelStrE = cons.stringifyLabel(LabelE);

    // node B
    var partB = sortPropLabel(propLabelB),
      propB = _.get(partB, '0.0'),
      LabelB = _.get(partB, '1.0'),
      LabelStrB = cons.stringifyLabel(LabelB);

    // if it's a path query, discard propE, reform string
    if (pOpStr) {
      propE = undefined
      body = ', (b' + LabelStrB + literalizeProp(propB, 'propB') + '), ' +
        'p=' + pOpStr + '((a)-[e' + LabelStrE + distE + ']->(b))'
    } else {
      body = '-[e' + LabelStrE + literalizeProp(propE, 'propE') + distE + ']->' +
        '(b' + LabelStrB + literalizeProp(propB, 'propB') + ')'
    }
    props = _.pickBy({
      propA: propA,
      propE: propE,
      propB: propB
    })
  } else {
    // just a node query
    body = ''
    props = _.pickBy({
      propA: propA
    })
  }

  // Tail
  tail = (' ' + wOpStr + ' ' + sOpStr + ' ' + rOpStr).replace(/\s{2,}/g, ' ')

  return [
    head + body + tail, props
  ]
}

// // return all nodes
// console.log(pull([], 'RETURN a'))
//   // [ 'MATCH (a ) RETURN a', {} ]

// // return nodes with the prop
// console.log(pull([{
//     name: "A"
//   }], 'RETURN a'))
//   // [ 'MATCH (a {name: {propA}.name}) RETURN a', { propA: { name: 'A' } } ]

// // return nodes with the prop
// console.log(pull([{
//     name: "A"
//   }], 'RETURN a'))
//   // [ 'MATCH (a {name: {propA}.name}) RETURN a', { propA: { name: 'A' } } ]

// // return all nodes with the prop and label
// console.log(pull([{
//     name: "A"
//   }, 'alpha'], 'RETURN a'))
//   // [ 'MATCH (a:alpha {name: {propA}.name}) RETURN a', { propA: { name: 'A' } } ]

// // same as above
// console.log(pull([, 'alpha'], 'WHERE a.name="A"', 'RETURN a'))
//   // [ 'MATCH (a:alpha ) where a.name="A" RETURN a', {} ]

// // DETACH DELETE a node
// console.log(pull([, 'alpha'], 'WHERE a.name="C"', 'DETACH DELETE a'))
//   // [ 'MATCH (a ) where a.name="C" DETACH DELETE a', {} ]

// // SET properties
// console.log(pull(['alpha'], 'WHERE a.name="A"', 'SET a.age=10, a.sex="M"', 'RETURN a'))
//   // [ 'MATCH (a:alpha ) where a.name="A" SET a.age=10, a.sex="M" RETURN a', {} ]

// // REMOVE properties
// console.log(pull(['alpha'], 'WHERE a.name="A"', 'REMOVE a.age, a.sex', 'RETURN a'))
//   // [ 'MATCH (a:alpha ) where a.name="A" REMOVE a.age, a.sex RETURN a', {} ]

// // SHORTESTPATH return paths of: nodes and edges 0-2 units apart FROM node a, with the props and labels
// console.log(pull([{
//     name: 'A'
//   }, 'alpha'], ['*0..2'], 'SHORTESTPATH', 'RETURN p, DISTINCT(nodes(p))'))
//   // [ 'MATCH (a:alpha {name: {propA}.name})-[e:next *0..1]->(b )   return b,e', { propA: { name: 'A' } } ]

// // return nodes and edges 0-1 units apart FROM node a, with the props and labels
// console.log(pull([{
//     name: 'A'
//   }, 'alpha'], ['*0..1', 'next'], 'RETURN b,e'))
//   // [ 'MATCH (a:alpha {name: {propA}.name})-[e:next *0..1]->(b )   return b,e', { propA: { name: 'A' } } ]

// // return nodes and edges 0-1 units apart TO node B, with the props and labels
// console.log(pull([], ['*0..1', 'next'], [{
//     name: 'B'
//   }, 'alpha'], 'RETURN a,e'))
//   // [ 'MATCH (a )-[e:next *0..1]->(b:alpha {name: {propB}.name})   return a,e', { propB: { name: 'B' } } ]

// return nodes and edges units apart TO node B, with edge named 'E' and labeled 'next'
// console.log(pull([], [{
//       name: 'E'
//     },
//     ['next', 'xiage']
//   ], [{
//     name: 'B'
//   }, 'alpha'], 'RETURN a,e'))
// [ 'MATCH (a )-[e:next {name: {propE}.name}]->(b:alpha {name: {propB}.name})   return a,e', { propE: { name: 'E' }, propB: { name: 'B' } } ]

// // same as above, but source nodes must now have name that is lexicographically lower than "B"
// console.log(pull([], [{
//     name: 'E'
//   }, 'next'], [{
//     name: 'B'
//   }, 'alpha'], 'WHERE a.name < "B"', 'RETURN a,e'))
//   // [ 'MATCH (a )-[e:next {name: {propE}.name}]->(b:alpha {name: {propB}.name})  WHERE a.name < "B" return a,e', { propE: { name: 'E' }, propB: { name: 'B' } } ]

// // if E has an array of multiple labels, can use with splitLabelE
// console.log(splitLabelE(pull([], [{
//     name: 'E'
//   },
//   ['next', 'xiage']
// ], [{
//   name: 'B'
// }, 'alpha'], 'WHERE a.name < "B"', 'RETURN a,e')))



// ohhh edge label | label1 | label2 can be allowed shit

// new target, (worse case take extra arg).
// yeah need extra arg, just make it seems like the old query except to
// return a path form instead of plain(pLA, pLE, pLA, wOp, sOp, rOp, pOp)
// path can only allow edge[] to have label and Dist

// console.log(cons.isLegalSentence('SHORTESTPATH'))
// head = MATCH (a:LabelA {propA})
// body = -[e:LabelE {propE}|*Dist]->(b:LabelB {propB})
// tail = WHERE ... SET|REMOVE ... RETURN|DELETE|DETACH DELETE ...

// MATCH (a:alpha {name:"A"}), (b:alpha {name:"B"}), p=shortestPath((a)-[e:next*]-(b)) RETURN p

// need to change body:
// nopath body = -[e:LabelE {propE}|*Dist]->(b:LabelB {propB})
// withpath body = , (b:LabelB {propB}), p=<pOp>((a)-[e:LabelE*Dist]-(b))



/**
 * Get graph and do whatever u want with the search results: filter, RETURN, DELETE, DETACH DELETE. Graph: node(s) and edge(s) from neo4j with propLabel of nodes A -> B with the edge E. The propLabel for A, B and E is an array of a optional non-empty JSON prop (doesn't have to satisfy KB constraints), and a (optional for A,B; required for E) Label string or array.
 * This is a flexible method used for querying node(s), or optionally edge(s) and node(s). It also takes an optional WHERE filter sentence string, and a required RETURN sentence string.The resultant query string is of the form:
 * For nodes: MATCH (a:LabelA {propA}) <wOp> <sOp> <rOp>
 * For nodes and edges: MATCH (a:LabelA {propA})-[e:LabelE ({propE}|*Dist)]-(b:LabelB {propB}) <wOp> <sOp> <rOp> <pOp>
 * 
 * @param  {*}  single_query, As (fn, *, *, ...), e.g. (fn, [p, L], [p|D, L], [p, L], wOp, rOp)
 * @param  {*}  multi_queries As (fn, [*], [*], [*]...), e.g. (fn, [[p, L], [p|D, L], [p, L], wOp, rOp], [[p, L], [p|D, L], [p, L], wOp, rOp], ...)
 * @param  {*}  multi_queries_one_array As (fn, [[*], [*], [*]...]), e.g. (fn, [[[p, L], [p|D, L], [p, L], wOp, rOp], [[p, L], [p|D, L], [p, L], wOp, rOp], ...])
 * @return {Promise}          From the query.
 *
 * @example
 * // a rank 1 arguments. 
 * // Get only node(s)
 * get([{
 *   name: 'A'
 * }, 'alpha'], 'RETURN a').then(_.flow(JSON.stringify, console.log))
 *
 * // a rank 1 arguments. 
 * // Delete node(s)
 * get([{
 *   name: 'C'
 * }, 'alpha'], 'DETACH DELETE a').then(_.flow(JSON.stringify, console.log))
 * 
 * // a rank 1 arguments. 
 * // Get nodes and edges. Note that labelE is optional now
 * get([{
 *   name: 'A'
 * }, 'alpha'], ['*0..1'], 'RETURN b,e').then(_.flow(JSON.stringify, console.log))
 * 
 * // a rank 2 arguments
 * // Get nodes and edges
 * get([
 *   [{
 *     name: 'A'
 *   }, 'alpha'],
 *   ['*0..1', 'next'], 'RETURN b,e'
 * ]).then(_.flow(JSON.stringify, console.log))
 *
 * // a rank 2 arguments
 * // Get nodes and edges. Edges can have multiple labels in query; piped
 * get([
 *   [{
 *     name: 'A'
 *   }, 'alpha'],
 *   ['*0..1', ['next', 'xiage']], 'RETURN b,e'
 * ]).then(_.flow(JSON.stringify, console.log))
 * 
 */
var get = _.partial(batchQuery, pull)

// // a rank 1 arguments. 
// // Get only node(s)
// get([{
//   name: 'A'
// }, 'alpha'], 'RETURN a').then(_.flow(JSON.stringify, console.log))

// // a rank 1 arguments. 
// // Delete node(s)
// get([{
//   name: 'C'
// }, 'alpha'], 'DETACH DELETE a').then(_.flow(JSON.stringify, console.log))

// // a rank 1 arguments. 
// // Get nodes and edges. Note that labelE is optional now
// get([{
//   name: 'A'
// }, 'alpha'], ['*0..1'], 'RETURN b,e').then(_.flow(JSON.stringify, console.log))

// // a rank 2 arguments
// // Get nodes and edges
// get([
//   [{
//     name: 'A'
//   }, 'alpha'],
//   ['*0..1', 'next'], 'RETURN b,e'
// ]).then(_.flow(JSON.stringify, console.log))

// // a rank 2 arguments
// // Get nodes and edges. Edges can have multiple labels in query; piped
// get([
//   [{
//     name: 'A'
//   }, 'alpha'],
//   ['*0..1', ['next', 'xiage']], 'RETURN b,e'
// ]).then(_.flow(JSON.stringify, console.log))



// shit gotta wrap all these shits
import debugModule from "debug";
const debug = debugModule("debugger:data:sagas");

import { put, takeEvery, select } from "redux-saga/effects";
import jsonpointer from "json-pointer";

import { prefixName, stableKeccak256 } from "lib/helpers";

import { TICK } from "lib/trace/actions";
import * as actions from "../actions";

import data from "../selectors";

import { WORD_SIZE } from "lib/data/decode/utils";
import * as utils from "lib/data/decode/utils";

export function* scope(nodeId, pointer, parentId, sourceId) {
  yield put(actions.scope(nodeId, pointer, parentId, sourceId));
}

export function* declare(node) {
  yield put(actions.declare(node));
}

function* tickSaga() {
  let { tree, id: treeId, node, pointer } = yield select(data.views.ast);

  let decode = yield select(data.views.decoder);
  let scopes = yield select(data.info.scopes);
  let definitions = yield select(data.views.scopes.inlined);
  let currentAssignments = yield select(data.proc.assignments);
  let currentDepth = yield select(data.current.functionDepth);
  let address = yield select(data.current.address); //may be undefined
  let dummyAddress = yield select(data.current.dummyAddress);

  let stack = yield select(data.next.state.stack);
  if (!stack) {
    return;
  }

  let top = stack.length - 1;
  var parameters, returnParameters, assignment, assignments, storageVars;

  if (!node) {
    return;
  }

  // stack is only ready for interpretation after the last step of each
  // source range
  //
  // the data module always looks at the result of a particular opcode
  // (i.e., the following trace step's stack/memory/storage), so this
  // asserts that the _current_ operation is the final one before
  // proceeding
  if (!(yield select(data.views.atLastInstructionForSourceRange))) {
    return;
  }

  switch (node.nodeType) {
    case "FunctionDefinition":
      parameters = node.parameters.parameters.map(
        (p, i) => `${pointer}/parameters/parameters/${i}`
      );

      returnParameters = node.returnParameters.parameters.map(
        (p, i) => `${pointer}/returnParameters/parameters/${i}`
      );

      assignments = { byId: Object.assign({},
        ...returnParameters.concat(parameters).reverse()
        .map( (pointer) => jsonpointer.get(tree, pointer).id )
        //note: depth may be off by 1 but it doesn't matter
        .map( (id, i) => 
          makeAssignment({astId: id, stackframe: currentDepth},
            {"stack": top - i}))
        .map( (assignment) => {
          return {[assignment.id]: assignment};
          //awkward, but seems to be only way to return an object literal
        })
      )};
      debug("Function definition case");
      debug("assignments %O", assignments);

      yield put(actions.assign(treeId, assignments));
      break;

    case "ContractDefinition":
      let storageVars = scopes[node.id].variables || [];
      let slot = 0;
      let index = WORD_SIZE - 1; // cause lower-order
      debug("storage vars %o", storageVars);

      let allocation = utils.allocateDeclarations(storageVars, definitions);
      debug("Contract definition case");
      debug("allocation %O", allocation);
      assignments = {byId: {}};
      for(let id in allocation.children){
        id = Number(id); //not sure why we're getting them as strings, but...
        let idObj;
        if(address !== undefined) {
          idObj = {astId: id, address};
        }
        else {
          idObj = {astId: id, dummyAddress};
        }
        let fullId = stableKeccak256(idObj);
        //we don't use makeAssignment here as we had to compute the ID anyway
        assignment = {
          ...idObj,
          id: fullId,
          ref: {
              ...((currentAssignments.byId[fullId] || {}).ref || {}),
              storage: allocation.children[id]
          }
        }
        assignments.byId[fullId] = assignment;
      }
      debug("assignments %O", assignments);

      yield put(actions.assign(treeId, assignments));
      break;

    case "VariableDeclaration":
      let varId = jsonpointer.get(tree, pointer).id;
      debug("Variable declaration case");
      debug("currentDepth %d varId %d", currentDepth, varId);

      //NOTE: We're going to make the assignment conditional here; here's why.
      //There's a bug where calling the autogenerated accessor for a public
      //contract variable causes the debugger to see two additional
      //declarations for that variable... which this code reads as local
      //variable declarations.  Rather than prevent this at the source, we're
      //just going to check for it here, by not adding a local variable if said
      //variable is already a contract variable.

      if(currentAssignments.byAstId[varId] !== undefined &&
	   currentAssignments.byAstId[varId].some(
             (id) => currentAssignments.byId[id].address !== undefined ||
               currentAssignments.byId[id].dummyAddress !== undefined
        ))
      {
        break;
      }

      //otherwise, go ahead and make the assignment
      assignment = makeAssignment(
        {astId: varId, stackframe: currentDepth},
        {"stack": top});
      assignments = {byId : {[assignment.id]: assignment}};
      yield put(actions.assign(treeId, assignments));
      break;

    case "IndexAccess":
      // to track `mapping` types known indexes
      let {
        baseExpression: { referencedDeclaration: baseDeclarationId },
        indexExpression: { id: indexId }
      } = node;

      //indices need to be identified by stackframe
      let indexIdObj = {astId: indexId, stackframe: currentDepth};
      let fullIndexId = stableKeccak256(indexIdObj);

      debug("Index access case");

      const indexAssignment = (currentAssignments.byId[fullIndexId] || {}).ref;
      debug("indexAssignment %O", indexAssignment);
      // HACK because string literal AST nodes are not sourcemapped to directly
      // value appears to be available in `node.indexExpression.hexValue`
      // [observed with solc v0.4.24]
      let indexValue;
      if (indexAssignment) {
        indexValue = decode(node.indexExpression, indexAssignment);
      } else if (utils.typeClass(node.indexExpression) == "stringliteral") {
        indexValue = decode(node.indexExpression, {
          literal: utils.toBytes(node.indexExpression.hexValue)
        });
      }

      debug("index value %O", indexValue);
      if (indexValue !== undefined) {
        yield put(actions.mapKey(baseDeclarationId, indexValue));
      }

      break;

    case "Assignment":
      break;

    default:
      if (node.typeDescriptions == undefined) {
        break;
      }

      debug("decoding expression value %O", node.typeDescriptions);
      let literal = stack[top];

      debug("default case");
      debug("currentDepth %d node.id %d", currentDepth, node.id);
      assignment = makeAssignment({astId: node.id, stackframe: currentDepth},
        {literal});
      assignments = {byId : {[assignment.id]: assignment}};
      yield put(actions.assign(treeId, assignments));
      break;
  }
}

export function* reset() {
  yield put(actions.reset());
}

export function *learnAddressSaga(dummyAddress, address)
{
  debug("about to learn an address");
  yield put(actions.learnAddress(dummyAddress, address));
  debug("address learnt");
}

function makeAssignment(idObj, ref) {
  let id = stableKeccak256(idObj);
  return { ...idObj, id, ref };
}

export function* saga () {
  yield takeEvery(TICK, function* () {
    try {
      yield* tickSaga();
    } catch (e) {
      debug(e);
    }
  });
}

export default prefixName("data", saga);

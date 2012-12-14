/*
 * Copyright (c) 2012 Adobe Systems Incorporated. All rights reserved.
 *  
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), 
 * to deal in the Software without restriction, including without limitation 
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the 
 * Software is furnished to do so, subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *  
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 * DEALINGS IN THE SOFTWARE.
 * 
 */


/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4, maxerr: 50 */
/*global define, $, CodeMirror, _parseRuleList: true */

// JSLint Note: _parseRuleList() is cyclical dependency, not a global function.
// It was added to this list to prevent JSLint warning about being used before being defined.

/**
 * Set of utilities for simple parsing of CSS text.
 */
define(function (require, exports, module) {
    "use strict";
    
    var Async               = require("utils/Async"),
        DocumentManager     = require("document/DocumentManager"),
        EditorManager       = require("editor/EditorManager"),
        HTMLUtils           = require("language/HTMLUtils"),
        FileIndexManager    = require("project/FileIndexManager"),
        NativeFileSystem    = require("file/NativeFileSystem").NativeFileSystem,
        TokenUtils          = require("utils/TokenUtils");

    // Constants
    var SELECTOR   = "selector",
        PROP_NAME  = "prop.name",
        PROP_VALUE = "prop.value";

    /**
     * @private
     * Checks if the current cursor position is inside the property name context
     * @param {editor:{CodeMirror}, pos:{ch:{string}, line:{number}}, token:{object}} context
     * @return {boolean} true if the context is in property name
     */
    function _isInPropName(ctx) {
        var state,
            lastToken;
        if (!ctx || !ctx.token || !ctx.token.state) {
            return false;
        }

        state = ctx.token.state.localState || ctx.token.state;
        
        if (!state.stack || state.stack.length < 1) {
            return false;
        }
        
        lastToken = state.stack[state.stack.length - 1];
        return (lastToken === "{") ||
                (lastToken === "rule" &&
                (ctx.token.className === "variable" || ctx.token.className === "tag"));
    }
    
    /**
     * @private
     * Checks if the current cursor position is inside the property value context
     * @param {editor:{CodeMirror}, pos:{ch:{string}, line:{number}}, token:{object}} context
     * @return {boolean} true if the context is in property value
     */
    function _isInPropValue(ctx) {
        var state;
        if (!ctx || !ctx.token || !ctx.token.state ||
                ctx.token.className === "variable" || ctx.token.className === "tag") {
            return false;
        }

        state = ctx.token.state.localState || ctx.token.state;
        
        if (!state.stack || state.stack.length < 2) {
            return false;
        }
        return (state.stack[state.stack.length - 1] === "rule");
    }
    
    /**
     * @private
     * Creates a context info object
     * @param {string} context A constant string 
     * @param {number} offset The offset of the token for a given cursor position
     * @param {string} name Property name of the context 
     * @param {number} index The index of the property value for a given cursor position
     * @param {Array.<string>} values An array of property values 
     * @param {boolean} isNewItem If this is true, then the value in index refers to the index at which a new item  
     *     is going to be inserted and should not be used for accessing an existing value in values array. 
     * @return {{context: string,
     *           offset: number,
     *           name: string,
     *           index: number,
     *           values: Array.<string>,
     *           isNewItem: boolean}} A CSS context info object.
     */
    function createInfo(context, offset, name, index, values, isNewItem) {
        var ruleInfo = { context: context || "",
                         offset: offset || 0,
                         name: name || "",
                         index: -1,
                         values: [],
                         isNewItem: false };
        
        if (isNewItem !== undefined) {
            ruleInfo.isNewItem = isNewItem;
        }
        
        if (context === PROP_VALUE || context === SELECTOR) {
            ruleInfo.index = index;
            ruleInfo.values = values;
        }
        
        return ruleInfo;
    }

    /**
     * @private
     * Scans backwards from the current context and returns the name of the property if there is 
     * a valid one. 
     * @param {editor:{CodeMirror}, pos:{ch:{string}, line:{number}}, token:{object}} context
     * @return {string} the property name of the current rule.
     */
    function _getPropNameStartingFromPropValue(ctx) {
        var ctxClone = $.extend({}, ctx);
        do {
            // If we get a property name or "{" or ";" before getting a colon, then we don't 
            // have a valid property name. Just return an empty string.
            if (ctxClone.token.className === "variable" || ctxClone.token.string === "{" || ctxClone.token.string === ";") {
                return "";
            }
        } while (ctxClone.token.string !== ":" && TokenUtils.moveSkippingWhitespace(TokenUtils.movePrevToken, ctxClone));
        
        if (ctxClone.token.string === ":" && TokenUtils.moveSkippingWhitespace(TokenUtils.movePrevToken, ctxClone) &&
                ctxClone.token.className === "variable") {
            return ctxClone.token.string;
        }
        
        return "";
    }
    
    /**
     * @private
     * Gets all of the space/comma seperated tokens before the the current cursor position.
     * @param {editor:{CodeMirror}, pos:{ch:{string}, line:{number}}, token:{object}} context
     * @return {?Array.<string>} An array of all the space/comma seperated tokens before the
     *    current cursor position
     */
    function _getPrecedingPropValues(ctx) {
        var lastValue = "",
            curValue,
            propValues = [];
        while (ctx.token.string !== ":" && TokenUtils.movePrevToken(ctx)) {
            if (ctx.token.className === "variable" || ctx.token.className === "tag" ||
                    ctx.token.string === ":" || ctx.token.string === "{" ||
                    ctx.token.string === ";") {
                break;
            }
            curValue = ctx.token.string;
            if (lastValue !== "") {
                curValue += lastValue;
            }
            if ((ctx.token.string.length > 0 && !ctx.token.string.match(/\S/)) ||
                    ctx.token.string === ",") {
                lastValue = curValue;
            } else {
                lastValue = "";
                propValues.push(curValue);
            }
        }
        if (propValues.length > 0) {
            propValues.reverse();
        }
        
        return propValues;
    }
    
    /**
     * @private
     * Gets all of the space/comma seperated tokens after the the current cursor position.
     * @param {editor:{CodeMirror}, pos:{ch:{string}, line:{number}}, token:{object}} context
     * @param {string} currentValue The token string at the current cursor position
     * @return {?Array.<string>} An array of all the space/comma seperated tokens after the
     *    current cursor position
     */
    function _getSucceedingPropValues(ctx, currentValue) {
        var lastValue = currentValue,
            curValue,
            propValues = [];
        
        while (ctx.token.string !== ";" && TokenUtils.moveNextToken(ctx)) {
            if (ctx.token.string === ";" || ctx.token.string === "}") {
                break;
            }
            // If we're already in the next rule, then we don't want to add the last value
            // since it is the property name of the next rule.
            if (ctx.token.className === "variable" || ctx.token.className === "tag" ||
                    ctx.token.string === ":") {
                lastValue = "";
                break;
            }
            
            if (lastValue === "") {
                lastValue = ctx.token.string.trim();
            } else if (lastValue.length > 0) {
                if (ctx.token.string.length > 0 && !ctx.token.string.match(/\S/)) {
                    lastValue += ctx.token.string;
                    propValues.push(lastValue);
                    lastValue = "";
                } else if (ctx.token.string === ",") {
                    lastValue += ctx.token.string;
                } else if (lastValue && lastValue.match(/,$/)) {
                    propValues.push(lastValue);
                    lastValue = "";
                }
            }
        }
        if (lastValue.length > 0) {
            propValues.push(lastValue);
        }

        return propValues;
    }
    
    /**
     * @private
     * Returns a context info object for the current CSS rule
     * @param {editor:{CodeMirror}, pos:{ch:{string}, line:{number}}, token:{object}} context
     * @param {!Editor} editor
     * @return {{context: string,
     *           offset: number,
     *           name: string,
     *           index: number,
     *           values: Array.<string>,
     *           isNewItem: boolean}} A CSS context info object.
     */
    function _getRuleInfoStartingFromPropValue(ctx, editor) {
        var backwardCtx = $.extend({}, ctx),
            forwardCtx = $.extend({}, ctx),
            lastValue = "",
            propValues = [],
            index = -1,
            offset = TokenUtils.offsetInToken(ctx),
            canAddNewOne = false,
            testPos = {ch: ctx.pos.ch + 1, line: ctx.pos.line},
            testToken = editor._codeMirror.getTokenAt(testPos),
            propName;
        
        // Get property name first. If we don't have a valid property name, then 
        // return a default rule info.
        propName = _getPropNameStartingFromPropValue(ctx);
        if (!propName) {
            return createInfo();
        }
        
        // Scan backward to collect all preceding property values
        propValues = _getPrecedingPropValues(backwardCtx);

        lastValue = "";
        if (ctx.token.string === ":") {
            index = 0;
            canAddNewOne = true;
        } else {
            index = propValues.length - 1;
            if (ctx.token.string === ",") {
                propValues[index] += ctx.token.string;
                index++;
                canAddNewOne = true;
            } else {
                index = (index < 0) ? 0 : index + 1;
                lastValue = ctx.token.string.trim();
                if (lastValue.length === 0) {
                    canAddNewOne = true;
                    if (index > 0) {
                        // Append all spaces before the cursor to the previous value in values array
                        propValues[index - 1] += ctx.token.string.substr(0, offset);
                    }
                }
            }
        }
        
        if (canAddNewOne) {
            offset = 0;
            if (testToken.string.length === 0 || testToken.string.match(/\S/)) {
                canAddNewOne = false;
            }
        }
        
        // Scan forward to collect all succeeding property values and append to all propValues.
        propValues = propValues.concat(_getSucceedingPropValues(forwardCtx, lastValue));

        // If current index is more than the propValues size, then the cursor is 
        // at the end of the existing property values and ready for adding another one.
        // So add a new empty string for the new one in propValues.
        if (index === propValues.length) {
            propValues.push("");
        }
               
        return createInfo(PROP_VALUE, offset, propName, index, propValues, canAddNewOne);
    }
    
    /**
     * Returns a context info object for the given cursor position
     * @param {!Editor} editor
     * @param {{ch: number, line: number}} constPos  A CM pos (likely from editor.getCursor())
     * @return {{context: string,
     *           offset: number,
     *           name: string,
     *           index: number,
     *           values: Array.<string>,
     *           isNewItem: boolean}} A CSS context info object.
     */
    function getInfoAtPos(editor, constPos) {
        // We're going to be changing pos a lot, but we don't want to mess up
        // the pos the caller passed in so we use extend to make a safe copy of it.	
        var pos = $.extend({}, constPos),
            ctx = TokenUtils.getInitialContext(editor._codeMirror, pos),
            offset = TokenUtils.offsetInToken(ctx),
            propName = "",
            mode = editor.getModeForSelection();
        
        // Check if this is inside a style block or in a css/less document.
        if (mode !== "css" && mode !== "less") {
            return createInfo();
        }

        if (_isInPropName(ctx)) {
            if (ctx.token.string.length > 0 && !ctx.token.string.match(/\S/)) {
                var testPos = {ch: ctx.pos.ch + 1, line: ctx.pos.line},
                    testToken = editor._codeMirror.getTokenAt(testPos);
                
                if (testToken.className === "variable" || testToken.className === "tag") {
                    propName = testToken.string;
                    offset = 0;
                }
            } else if (ctx.token.className === "variable" || ctx.token.className === "tag") {
                propName = ctx.token.string;
            }
            
            // If we're in property name context but not in an existing property name, 
            // then reset offset to zero.
            if (propName === "") {
                offset = 0;
            }
            
            return createInfo(PROP_NAME, offset, propName);
        }
        
        if (_isInPropValue(ctx)) {
            return _getRuleInfoStartingFromPropValue(ctx, editor);
        }
                    
        return createInfo();
    }
    
    /**
     * Extracts all CSS selectors from the given text
     * Returns an array of selectors. Each selector is an object with the following properties:
         selector:                 the text of the selector (note: comma separated selector groups like 
                                   "h1, h2" are broken into separate selectors)
         ruleStartLine:            line in the text where the rule (including preceding comment) appears
         ruleStartChar:            column in the line where the rule (including preceding comment) starts
         selectorStartLine:        line in the text where the selector appears
         selectorStartChar:        column in the line where the selector starts
         selectorEndLine:          line where the selector ends
         selectorEndChar:          column where the selector ends
         selectorGroupStartLine:   line where the comma-separated selector group (e.g. .foo, .bar, .baz)
                                   starts that this selector (e.g. .baz) is part of. Particularly relevant for
                                   groups that are on multiple lines.
         selectorGroupStartChar:   column in line where the selector group starts.
         declListStartLine:        line where the declaration list for the rule starts
         declListStartChar:        column in line where the declaration list for the rule starts
         declListEndLine:          line where the declaration list for the rule ends
         declListEndChar:          column in the line where the declaration list for the rule ends
     * @param text {!String} CSS text to extract from
     * @return {Array.<Object>} Array with objects specifying selectors.
     */
    function extractAllSelectors(text) {
        var selectors = [];
        var mode = CodeMirror.getMode({indentUnit: 2}, "css");
        var state, lines, lineCount;
        var token, style, stream, line;
        var currentSelector = "";
        var ruleStartChar = -1, ruleStartLine = -1;
        var selectorStartChar = -1, selectorStartLine = -1;
        var selectorGroupStartLine = -1, selectorGroupStartChar = -1;
        var declListStartLine = -1, declListStartChar = -1;
        var escapePattern = new RegExp("\\\\[^\\\\]+", "g");
        var validationPattern = new RegExp("\\\\([a-f0-9]{6}|[a-f0-9]{4}(\\s|\\\\|$)|[a-f0-9]{2}(\\s|\\\\|$)|.)", "i");
        
        // implement _firstToken()/_nextToken() methods to
        // provide a single stream of tokens
        
        function _hasStream() {
            while (stream.eol()) {
                line++;
                if (line >= lineCount) {
                    return false;
                }
                if (currentSelector.match(/\S/)) {
                    // If we are in a current selector and starting a newline,
                    // make sure there is whitespace in the selector
                    currentSelector += " ";
                }
                stream = new CodeMirror.StringStream(lines[line]);
            }
            return true;
        }
        
        function _firstToken() {
            state = CodeMirror.startState(mode);
            lines = CodeMirror.splitLines(text);
            lineCount = lines.length;
            if (lineCount === 0) {
                return false;
            }
            line = 0;
            stream = new CodeMirror.StringStream(lines[line]);
            if (!_hasStream()) {
                return false;
            }
            style = mode.token(stream, state);
            token = stream.current();
            return true;
        }
        
        function _nextToken() {
            // advance the stream past this token
            stream.start = stream.pos;
            if (!_hasStream()) {
                return false;
            }
            style = mode.token(stream, state);
            token = stream.current();
            return true;
        }
        
        function _firstTokenSkippingWhitespace() {
            if (!_firstToken()) {
                return false;
            }
            while (!token.match(/\S/)) {
                if (!_nextToken()) {
                    return false;
                }
            }
            return true;
        }
        
        function _nextTokenSkippingWhitespace() {
            if (!_nextToken()) {
                return false;
            }
            while (!token.match(/\S/)) {
                if (!_nextToken()) {
                    return false;
                }
            }
            return true;
        }

        function _isStartComment() {
            return (token.match(/^\/\*/));
        }
        
        function _parseComment() {
            while (!token.match(/\*\/$/)) {
                if (!_nextToken()) {
                    break;
                }
            }
        }

        function _nextTokenSkippingComments() {
            if (!_nextToken()) {
                return false;
            }
            while (_isStartComment()) {
                _parseComment();
                if (!_nextToken()) {
                    return false;
                }
            }
            return true;
        }

        function _parseSelector() {
            
            currentSelector = "";
            selectorStartChar = stream.start;
            selectorStartLine = line;
            
            // Everything until the next ',' or '{' is part of the current selector
            while (token !== "," && token !== "{") {
                currentSelector += token;
                if (!_nextTokenSkippingComments()) {
                    break;
                }
            }
            
            // Unicode character replacement as defined in http://www.w3.org/TR/CSS21/syndata.html#characters
            if (/\\/.test(currentSelector)) {
                // Double replace in case of pattern overlapping (regex improvement?)
                currentSelector = currentSelector.replace(escapePattern, function (escapedToken) {
                    return escapedToken.replace(validationPattern, function (unicodeChar) {
                        unicodeChar = unicodeChar.substr(1);
                        if (unicodeChar.length === 1) {
                            return unicodeChar;
                        } else {
                            if (parseInt(unicodeChar, 16) < 0x10FFFF) {
                                return String.fromCharCode(parseInt(unicodeChar, 16));
                            } else { return String.fromCharCode(0xFFFD); }
                        }
                    });
                });
            }
            
            currentSelector = currentSelector.trim();
            if (currentSelector !== "") {
                selectors.push({selector: currentSelector,
                                ruleStartLine: ruleStartLine,
                                ruleStartChar: ruleStartChar,
                                selectorStartLine: selectorStartLine,
                                selectorStartChar: selectorStartChar,
                                declListEndLine: -1,
                                selectorEndLine: line,
                                selectorEndChar: stream.start - 1, // stream.start points to the first char of the non-selector token
                                selectorGroupStartLine: selectorGroupStartLine,
                                selectorGroupStartChar: selectorGroupStartChar
                               });
                currentSelector = "";
            }
            selectorStartChar = -1;
        }
        
        function _parseSelectorList() {

            selectorGroupStartLine = line;
            selectorGroupStartChar = stream.start;

            _parseSelector();
            while (token === ",") {
                if (!_nextTokenSkippingComments()) {
                    break;
                }
                _parseSelector();
            }
        }

        function _parseDeclarationList() {

            var j;
            declListStartLine = line;
            declListStartChar = stream.start;

            // Since we're now in a declaration list, that means we also finished
            // parsing the whole selector group. Therefore, reset selectorGroupStartLine
            // so that next time we parse a selector we know it's a new group
            selectorGroupStartLine = -1;
            selectorGroupStartChar = -1;
            ruleStartLine = -1;
            ruleStartChar = -1;

            // Skip everything until the next '}'
            while (token !== "}") {
                if (!_nextTokenSkippingComments()) {
                    break;
                }
            }
            
            // assign this declaration list position to every selector on the stack
            // that doesn't have a declaration list start and end line
            for (j = selectors.length - 1; j >= 0; j--) {
                if (selectors[j].declListEndLine !== -1) {
                    break;
                } else {
                    selectors[j].declListStartLine = declListStartLine;
                    selectors[j].declListStartChar = declListStartChar;
                    selectors[j].declListEndLine = line;
                    selectors[j].declListEndChar = stream.pos - 1; // stream.pos actually points to the char after the }
                }
            }
        }
        
        function includeCommentInNextRule() {
            if (ruleStartChar !== -1) {
                return false;       // already included
            }
            if (stream.start > 0 && lines[line].substr(0, stream.start).indexOf("}") !== -1) {
                return false;       // on same line as '}', so it's for previous rule
            }
            return true;
        }
        
        function _isStartAtRule() {
            return (token.match(/^@/));
        }
        
        function _parseAtRule() {

            // reset these fields to ignore comments preceding @rules
            ruleStartLine = -1;
            ruleStartChar = -1;
            selectorStartLine = -1;
            selectorStartChar = -1;
            selectorGroupStartLine = -1;
            selectorGroupStartChar = -1;
            
            if (token.match(/@media/i)) {
                // @media rule holds a rule list
                
                // Skip everything until the opening '{'
                while (token !== "{") {
                    if (!_nextTokenSkippingComments()) {
                        break;
                    }
                }
                _nextTokenSkippingWhitespace();    // skip past '{', to next non-ws token

                // Parse rules until we see '}'
                _parseRuleList("}");

            } else if (token.match(/@(charset|import|namespace)/i)) {
                
                // This code handles @rules in this format:
                //   @rule ... ;
                // Skip everything until the next ';'
                while (token !== ";") {
                    if (!_nextTokenSkippingComments()) {
                        break;
                    }
                }
                
            } else {
                // This code handle @rules that use this format:
                //    @rule ... { ... }
                // such as @page, @keyframes (also -webkit-keyframes, etc.), and @font-face.
                // Skip everything until the next '}'
                while (token !== "}") {
                    if (!_nextTokenSkippingComments()) {
                        break;
                    }
                }
            }
        }

        // parse a style rule
        function _parseRule() {
            _parseSelectorList();
            _parseDeclarationList();
        }
        
        function _parseRuleList(escapeToken) {
            
            while ((!escapeToken) || token !== escapeToken) {
                if (_isStartAtRule()) {
                    // @rule
                    _parseAtRule();
    
                } else if (_isStartComment()) {
                    // comment - make this part of style rule
                    if (includeCommentInNextRule()) {
                        ruleStartChar = stream.start;
                        ruleStartLine = line;
                    }
                    _parseComment();
    
                } else {
                    // Otherwise, it's style rule
                    if (ruleStartChar === -1) {
                        ruleStartChar = stream.start;
                        ruleStartLine = line;
                    }
                    _parseRule();
                }
                
                if (!_nextTokenSkippingWhitespace()) {
                    break;
                }
            }
        }
        
        // Do parsing

        if (_firstTokenSkippingWhitespace()) {

            // Style sheet is a rule list
            _parseRuleList();
        }

        return selectors;
    }
    
    /*
     * This code can be used to create an "independent" HTML document that can be passed to jQuery
     * calls. Allows using jQuery's CSS selector engine without actually putting anything in the browser's DOM
     *
    var _htmlDoctype = document.implementation.createDocumentType('html',
        '-//W3C//DTD XHTML 1.0 Strict//EN',
        'http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd'
    );
    var _htmlDocument = document.implementation.createDocument('http://www.w3.org/1999/xhtml', 'html', _htmlDoctype);

    function checkIfSelectorSelectsHTML(selector, theHTML) {
        $('html', _htmlDocument).html(theHTML);
        return ($(selector, _htmlDocument).length > 0);
    }
    */
    
    /**
     * Finds all instances of the specified selector in "text".
     * Returns an Array of Objects with start and end properties.
     *
     * For Sprint 4, we only support simple selectors. This function will need to change
     * dramatically to support full selectors.
     *
     * FUTURE: (JRB) It would be nice to eventually use the browser/jquery to do the selector evaluation.
     * One way to do this would be to take the user's HTML, add a special attribute to every tag with a UID,
     * and then construct a DOM (using the commented out code above). Then, give this DOM and the selector to 
     * jquery and ask what matches. If the node that the user's cursor is in comes back from jquery, then 
     * we know the selector applies.
     *
     * @param text {!String} CSS text to search
     * @param selector {!String} selector to search for
     * @return {Array.<{selectorGroupStartLine:number, declListEndLine:number, selector:string}>}
     *      Array of objects containing the start and end line numbers (0-based, inclusive range) for each
     *      matched selector.
     */
    function _findAllMatchingSelectorsInText(text, selector) {
        var allSelectors = extractAllSelectors(text);
        var result = [];
        var i;
        
        // For sprint 4 we only match the rightmost simple selector, and ignore 
        // attribute selectors and pseudo selectors
        var classOrIdSelector = selector[0] === "." || selector[0] === "#";
        var prefix = "";
        
        // Escape initial "." in selector, if present.
        if (selector[0] === ".") {
            selector = "\\" + selector;
        }
        
        if (!classOrIdSelector) {
            // Tag selectors must have nothing, whitespace, or a combinator before it.
            selector = "(^|[\\s>+~])" + selector;
        }
        
        var re = new RegExp(selector + "(\\[[^\\]]*\\]|:{1,2}[\\w-()]+|\\.[\\w-]+|#[\\w-]+)*\\s*$", classOrIdSelector ? "" : "i");
        allSelectors.forEach(function (entry) {
            if (entry.selector.search(re) !== -1) {
                result.push(entry);
            } else if (!classOrIdSelector) {
                // Special case for tag selectors - match "*" as the rightmost character
                if (entry.selector.trim().search(/\*$/) !== -1) {
                    result.push(entry);
                }
            }
        });
        
        return result;
    }
    
    
    /**
     * Converts the results of _findAllMatchingSelectorsInText() into a simpler bag of data and
     * appends those new objects to the given 'resultSelectors' Array.
     * @param {Array.<{document:Document, lineStart:number, lineEnd:number}>} resultSelectors
     * @param {Array.<{selectorGroupStartLine:number, declListEndLine:number, selector:string}>} selectorsToAdd
     * @param {!Document} sourceDoc
     * @param {!number} lineOffset Amount to offset all line number info by. Used if the first line
     *          of the parsed CSS text is not the first line of the sourceDoc.
     */
    function _addSelectorsToResults(resultSelectors, selectorsToAdd, sourceDoc, lineOffset) {
        selectorsToAdd.forEach(function (selectorInfo) {
            resultSelectors.push({
                name: selectorInfo.selector,
                document: sourceDoc,
                lineStart: selectorInfo.ruleStartLine + lineOffset,
                lineEnd: selectorInfo.declListEndLine + lineOffset
            });
        });
    }
    
    /** Finds matching selectors in CSS files; adds them to 'resultSelectors' */
    function _findMatchingRulesInCSSFiles(selector, resultSelectors) {
        var result          = new $.Deferred(),
            cssFilesResult  = FileIndexManager.getFileInfoList("css");
        
        // Load one CSS file and search its contents
        function _loadFileAndScan(fullPath, selector) {
            var oneFileResult = new $.Deferred();
            
            DocumentManager.getDocumentForPath(fullPath)
                .done(function (doc) {
                    // Find all matching rules for the given CSS file's content, and add them to the
                    // overall search result
                    var oneCSSFileMatches = _findAllMatchingSelectorsInText(doc.getText(), selector);
                    _addSelectorsToResults(resultSelectors, oneCSSFileMatches, doc, 0);
                    
                    oneFileResult.resolve();
                })
                .fail(function (error) {
                    oneFileResult.reject(error);
                });
        
            return oneFileResult.promise();
        }
        
        // Load index of all CSS files; then process each CSS file in turn (see above)
        cssFilesResult.done(function (fileInfos) {
            Async.doInParallel(fileInfos, function (fileInfo, number) {
                return _loadFileAndScan(fileInfo.fullPath, selector);
            })
                .pipe(result.resolve, result.reject);
        });
        
        return result.promise();
    }
    
    /** Finds matching selectors in the <style> block of a single HTML file; adds them to 'resultSelectors' */
    function _findMatchingRulesInStyleBlocks(htmlDocument, selector, resultSelectors) {
        // HTMLUtils requires a real CodeMirror instance; make sure we can give it the right Editor
        var htmlEditor = EditorManager.getCurrentFullEditor();
        if (htmlEditor.document !== htmlDocument) {
            console.error("Cannot search for <style> blocks in HTML file other than current editor");
            return;
        }
        
        // Find all <style> blocks in the HTML file
        var styleBlocks = HTMLUtils.findStyleBlocks(htmlEditor);
        
        styleBlocks.forEach(function (styleBlockInfo) {
            // Search this one <style> block's content, appending results to 'resultSelectors'
            var oneStyleBlockMatches = _findAllMatchingSelectorsInText(styleBlockInfo.text, selector);
            _addSelectorsToResults(resultSelectors, oneStyleBlockMatches, htmlDocument, styleBlockInfo.start.line);
        });
    }
    
    /**
     * Return all rules matching the specified selector.
     * For Sprint 4, we only look at the rightmost simple selector. For example, searching for ".foo" will 
     * match these rules:
     *  .foo {}
     *  div .foo {}
     *  div.foo {}
     *  div .foo[bar="42"] {}
     *  div .foo:hovered {}
     *  div .foo::first-child
     * but will *not* match these rules:
     *  .foobar {}
     *  .foo .bar {}
     *  div .foo .bar {}
     *  .foo.bar {}
     *
     * @param {!String} selector The selector to match. This can be a tag selector, class selector or id selector
     * @param {?Document} htmlDocument An HTML file for context (so we can search <style> blocks)
     * @return {$.Promise} that will be resolved with an Array of objects containing the
     *      source document, start line, and end line (0-based, inclusive range) for each matching declaration list.
     *      Does not addRef() the documents returned in the array.
     */
    function findMatchingRules(selector, htmlDocument) {
        var result          = new $.Deferred(),
            resultSelectors = [];
        
        // Synchronously search for matches in <style> blocks
        if (htmlDocument) {
            _findMatchingRulesInStyleBlocks(htmlDocument, selector, resultSelectors);
        }
        
        // Asynchronously search for matches in all the project's CSS files
        // (results are appended together in same 'resultSelectors' array)
        _findMatchingRulesInCSSFiles(selector, resultSelectors)
            .done(function () {
                result.resolve(resultSelectors);
            })
            .fail(function (error) {
                result.reject(error);
            });
        
        return result.promise();
    }
    
    /**
     * Returns the selector(s) of the rule at the specified document pos, or "" if the position is 
     * is not within a style rule.
     *
     * @param {!Editor} editor Editor to search
     * @param {!{line: number, ch: number}} pos Position to search
     * @return {string} Selector(s) for the rule at the specified position, or "" if the position
     *          is not within a style rule. If the rule has multiple selectors, a comma-separated
     *          selector string is returned.
     */
    function findSelectorAtDocumentPos(editor, pos) {
        var cm = editor._codeMirror;
        var ctx = TokenUtils.getInitialContext(cm, $.extend({}, pos));
        var selector = "", inSelector = false, foundChars = false;

        function _stripAtRules(selector) {
            selector = selector.trim();
            if (selector.indexOf("@") === 0) {
                return "";
            }
            return selector;
        }
        
        // Parse a selector. Assumes ctx is pointing at the opening
        // { that is after the selector name.
        function _parseSelector(ctx) {
            var selector = "";
            
            // Skip over {
            TokenUtils.movePrevToken(ctx);
            
            while (true) {
                if (ctx.token.className !== "comment") {
                    // Stop once we've reached a {, }, or ;
                    if (/[\{\}\;]/.test(ctx.token.string)) {
                        break;
                    }
                    selector = ctx.token.string + selector;
                }
                if (!TokenUtils.movePrevToken(ctx)) {
                    break;
                }
            }
            
            return selector;
        }
        
        // scan backwards to see if the cursor is in a rule
        while (true) {
            if (ctx.token.className !== "comment") {
                if (ctx.token.string === "}") {
                    break;
                } else if (ctx.token.string === "{") {
                    selector = _parseSelector(ctx);
                    break;
                } else {
                    if (ctx.token.string.trim() !== "") {
                        foundChars = true;
                    }
                }
            }
            
            if (!TokenUtils.movePrevToken(ctx)) {
                break;
            }
        }
        
        selector = _stripAtRules(selector);
        
        // Reset the context to original scan position
        ctx = TokenUtils.getInitialContext(cm, $.extend({}, pos));
        
        // special case - we aren't in a selector and haven't found any chars,
        // look at the next immediate token to see if it is non-whitespace
        if (!selector && !foundChars) {
            if (TokenUtils.moveNextToken(ctx) && ctx.token.className !== "comment" && ctx.token.string.trim() !== "") {
                foundChars = true;
                ctx = TokenUtils.getInitialContext(cm, $.extend({}, pos));
            }
        }
        
        // At this point if we haven't found a selector, but have seen chars when
        // scanning, assume we are in the middle of a selector.
        if (!selector && foundChars) {
            // scan forward to see if the cursor is in a selector
            while (true) {
                if (ctx.token.className !== "comment") {
                    if (ctx.token.string === "{") {
                        selector = _parseSelector(ctx);
                        break;
                    } else if (ctx.token.string === "}" || ctx.token.string === ";") {
                        break;
                    }
                }
                if (!TokenUtils.moveNextToken(ctx)) {
                    break;
                }
            }
        }
        
        return _stripAtRules(selector);
    }
    
    exports._findAllMatchingSelectorsInText = _findAllMatchingSelectorsInText; // For testing only
    exports.findMatchingRules = findMatchingRules;
    exports.extractAllSelectors = extractAllSelectors;
    exports.findSelectorAtDocumentPos = findSelectorAtDocumentPos;

    exports.SELECTOR = SELECTOR;
    exports.PROP_NAME = PROP_NAME;
    exports.PROP_VALUE = PROP_VALUE;
    
    exports.getInfoAtPos = getInfoAtPos;

    // The createInfo is reallyonly for the unit tests so they can make the same  
    // structure to compare results with.
    exports.createInfo = createInfo;
});

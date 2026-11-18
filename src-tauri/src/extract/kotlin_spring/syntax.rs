//! Kotlin source -> a small syntax model, via tree-sitter (grammar `tree-sitter-kotlin-ng`).
//! Only what the Spring analysis needs: declarations, annotations, constructor parameters, calls in bodies.
//! No type resolution here; that is heuristic and lives in `spring.rs`.
use std::collections::BTreeMap;
use tree_sitter::{Node, Parser};

#[derive(Debug, Clone, Default)]
pub struct KtFile {
    pub path: String,
    pub package: String,
    pub imports: Vec<KtImport>,
    pub classes: Vec<KtClass>,
    /// `const val` values addressable as `NAME` and `Owner.NAME`.
    pub constants: BTreeMap<String, String>,
    /// Lines where the grammar could not parse the code; declarations there may be missing.
    pub parse_errors: Vec<u32>,
}

#[derive(Debug, Clone)]
pub struct KtImport {
    pub fqn: String,
    pub alias: Option<String>,
    pub star: bool,
}

#[derive(Debug, Clone, Default)]
pub struct AnnArg {
    pub name: Option<String>,
    pub strings: Vec<String>,
    /// Identifiers and dotted references, e.g. `Topics.X`, `RequestMethod.POST`, `Foo` from `Foo::class`.
    pub refs: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Annotation {
    pub name: String,
    pub args: Vec<AnnArg>,
    pub line: u32,
}

impl Annotation {
    pub fn chosen(&self, names: &[&str]) -> Vec<&AnnArg> {
        let named: Vec<_> = self.args.iter().filter(|a| a.name.as_deref().is_some_and(|n| names.contains(&n))).collect();
        if !named.is_empty() || !names.contains(&"value") {
            return named;
        }
        self.args.iter().filter(|a| a.name.is_none()).collect()
    }

    /// String values of the named argument(s); the positional argument counts as `value`. References are returned
    /// as is when there are no strings, so the caller can resolve constants.
    pub fn values(&self, names: &[&str]) -> Vec<String> {
        self.chosen(names).into_iter().flat_map(|a| if a.strings.is_empty() { a.refs.clone() } else { a.strings.clone() }).collect()
    }

    pub fn refs(&self, names: &[&str]) -> Vec<String> {
        self.chosen(names).into_iter().flat_map(|a| a.refs.clone()).collect()
    }
}

#[derive(Debug, Clone, Default)]
pub struct Param {
    pub name: String,
    pub type_name: String,
    pub annotations: Vec<Annotation>,
}

#[derive(Debug, Clone, Default)]
pub struct Arg {
    /// A plain string literal (no concatenation).
    pub string: Option<String>,
    /// A bare or dotted identifier.
    pub reference: Option<String>,
    /// `Foo(...)` -> `Foo`.
    pub constructed: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Call {
    /// `field` for `field.m()` or `this.field.m()`; None for a bare `m()`.
    pub receiver: Option<String>,
    pub method: String,
    pub args: Vec<Arg>,
    pub line: u32,
    /// Further calls of a fluent chain: `webClient.post().uri("/x")` -> [("uri", ["/x"])].
    pub chain: Vec<(String, Vec<Arg>)>,
}

#[derive(Debug, Clone, Default)]
pub struct Function {
    pub name: String,
    pub annotations: Vec<Annotation>,
    pub params: Vec<Param>,
    pub return_type: Option<String>,
    pub start_line: u32,
    pub signature_end_line: u32,
    pub end_line: u32,
    pub calls: Vec<Call>,
}

#[derive(Debug, Clone, Default)]
pub struct Property {
    pub name: String,
    pub type_name: Option<String>,
    pub annotations: Vec<Annotation>,
    pub modifiers: Vec<String>,
    pub string_value: Option<String>,
    pub line: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ClassKind {
    #[default]
    Class,
    Interface,
    Object,
}

#[derive(Debug, Clone, Default)]
pub struct TypeRef {
    pub name: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct KtClass {
    pub name: String,
    pub fqn: String,
    pub kind: ClassKind,
    pub annotations: Vec<Annotation>,
    pub constructor_params: Vec<Param>,
    pub supertypes: Vec<TypeRef>,
    pub functions: Vec<Function>,
    pub properties: Vec<Property>,
    pub start_line: u32,
    pub header_end_line: u32,
    pub end_line: u32,
}

impl KtClass {
    pub fn annotation(&self, names: &[&str]) -> Option<&Annotation> {
        self.annotations.iter().find(|a| names.contains(&a.name.as_str()))
    }
}

pub fn parse(path: &str, source: &str) -> KtFile {
    let mut parser = Parser::new();
    parser.set_language(&tree_sitter_kotlin_ng::LANGUAGE.into()).expect("kotlin grammar");
    let Some(tree) = parser.parse(source, None) else { return KtFile { path: path.into(), ..Default::default() } };
    let w = Walker { src: source };
    let root = tree.root_node();
    let mut file = KtFile { path: path.into(), ..Default::default() };
    for n in named(root) {
        match n.kind() {
            "package_header" => file.package = find(n, "qualified_identifier").map(|q| w.text(q).to_string()).unwrap_or_default(),
            "import" => {
                let fqn = find(n, "qualified_identifier").map(|q| w.text(q).to_string()).unwrap_or_default();
                let star = w.text(n).trim_end().ends_with('*');
                let alias = named(n).into_iter().filter(|c| c.kind() == "identifier").last().map(|c| w.text(c).to_string());
                file.imports.push(KtImport { fqn, alias, star });
            }
            _ => {}
        }
    }
    if root.has_error() {
        collect_errors(root, &mut file.parse_errors);
    }
    let prefix = if file.package.is_empty() { String::new() } else { format!("{}.", file.package) };
    w.declarations(root, &prefix, &mut file);
    file
}

fn collect_errors(n: Node, out: &mut Vec<u32>) {
    if n.is_error() || n.is_missing() {
        out.push(line(n));
        return;
    }
    for c in named(n) {
        if c.has_error() {
            collect_errors(c, out);
        }
    }
}

fn named(n: Node) -> Vec<Node> {
    let mut c = n.walk();
    n.named_children(&mut c).collect()
}

fn find<'a>(n: Node<'a>, kind: &str) -> Option<Node<'a>> {
    named(n).into_iter().find(|c| c.kind() == kind)
}

fn has_token(n: Node, token: &str) -> bool {
    let mut c = n.walk();
    let found = n.children(&mut c).any(|ch| !ch.is_named() && ch.kind() == token);
    found
}

fn line(n: Node) -> u32 {
    n.start_position().row as u32 + 1
}

fn end_line(n: Node) -> u32 {
    n.end_position().row as u32 + 1
}

struct Walker<'s> {
    src: &'s str,
}

impl<'s> Walker<'s> {
    fn text(&self, n: Node) -> &'s str {
        &self.src[n.byte_range()]
    }

    /// Classes, objects and top-level constants under `parent` (recursing into class bodies).
    fn declarations(&self, parent: Node, prefix: &str, file: &mut KtFile) {
        // The grammar sometimes detaches leading annotations from a declaration (e.g. after a star import) and
        // parses them as an `annotated_expression`; they belong to the next declaration.
        let mut detached: Vec<Annotation> = Vec::new();
        for n in named(parent) {
            match n.kind() {
                "annotated_expression" => self.detached_annotations(n, &mut detached),
                "class_declaration" | "object_declaration" | "companion_object" => {
                    let before = file.classes.len();
                    self.class(n, prefix, file);
                    // `class()` pushes nested classes first and the class itself last.
                    if let Some(c) = file.classes.get_mut(before..).and_then(|cs| cs.last_mut()) {
                        c.annotations.splice(0..0, detached.drain(..));
                    }
                }
                "property_declaration" => {
                    let p = self.property(n);
                    if p.modifiers.iter().any(|m| m == "const") {
                        if let Some(v) = p.string_value {
                            file.constants.insert(p.name, v);
                        }
                    }
                }
                _ => detached.clear(),
            }
        }
    }

    fn detached_annotations(&self, n: Node, out: &mut Vec<Annotation>) {
        for c in named(n) {
            match c.kind() {
                "annotation" => out.push(self.annotation(c)),
                "annotated_expression" => self.detached_annotations(c, out),
                // `@A("x")` detached this way keeps its arguments in a sibling: one positional argument.
                "parenthesized_expression" => {
                    if let Some(last) = out.last_mut().filter(|a| a.args.is_empty()) {
                        let mut arg = AnnArg::default();
                        named(c).into_iter().for_each(|v| self.collect_values(v, &mut arg));
                        last.args.push(arg);
                    }
                }
                _ => {}
            }
        }
    }

    fn class(&self, n: Node, prefix: &str, file: &mut KtFile) {
        let kind = match n.kind() {
            "object_declaration" | "companion_object" => ClassKind::Object,
            _ if has_token(n, "interface") => ClassKind::Interface,
            _ => ClassKind::Class,
        };
        let name = find(n, "identifier").map(|i| self.text(i).to_string()).unwrap_or_else(|| "Companion".into());
        let fqn = format!("{prefix}{name}");
        let annotations = find(n, "modifiers").map(|m| self.annotations(m)).unwrap_or_default();
        let constructor_params = find(n, "primary_constructor")
            .and_then(|pc| find(pc, "class_parameters"))
            .map(|cps| named(cps).into_iter().filter(|c| c.kind() == "class_parameter").map(|c| self.param(c)).collect())
            .unwrap_or_default();
        let supertypes = find(n, "delegation_specifiers")
            .map(|ds| named(ds).into_iter().filter_map(|d| self.supertype(d)).collect())
            .unwrap_or_default();
        let body = find(n, "class_body").or_else(|| find(n, "enum_class_body"));
        let header_end_line = body.map(|b| line(b)).unwrap_or_else(|| end_line(n));
        let mut class = KtClass {
            name: name.clone(),
            fqn: fqn.clone(),
            kind,
            annotations,
            constructor_params,
            supertypes,
            start_line: line(n),
            header_end_line,
            end_line: end_line(n),
            ..Default::default()
        };
        if let Some(body) = body {
            for m in named(body) {
                match m.kind() {
                    "function_declaration" => class.functions.push(self.function(m)),
                    "property_declaration" => class.properties.push(self.property(m)),
                    _ => {}
                }
            }
            self.declarations(body, &format!("{fqn}."), file);
        }
        for p in class.properties.iter().filter(|p| p.modifiers.iter().any(|m| m == "const")) {
            if let Some(v) = &p.string_value {
                file.constants.insert(p.name.clone(), v.clone());
                file.constants.insert(format!("{name}.{}", p.name), v.clone());
                if n.kind() == "companion_object" {
                    // Companion constants are addressed through the outer class: `Outer.NAME`.
                    if let Some(outer) = prefix.trim_end_matches('.').rsplit('.').next() {
                        file.constants.insert(format!("{outer}.{}", p.name), v.clone());
                    }
                }
            }
        }
        file.classes.push(class);
    }

    fn supertype(&self, d: Node) -> Option<TypeRef> {
        let t = find(d, "user_type").or_else(|| find(d, "constructor_invocation").and_then(|ci| find(ci, "user_type")))?;
        let args = find(t, "type_arguments")
            .map(|ta| named(ta).into_iter().filter_map(|p| self.type_name_of(p)).collect())
            .unwrap_or_default();
        Some(TypeRef { name: self.user_type_name(t), args })
    }

    fn user_type_name(&self, t: Node) -> String {
        named(t).into_iter().filter(|c| c.kind() == "identifier").map(|c| self.text(c)).collect::<Vec<_>>().join(".")
    }

    /// Name of the first type found under `n` (generics and nullability stripped).
    fn type_name_of(&self, n: Node) -> Option<String> {
        if n.kind() == "user_type" {
            return Some(self.user_type_name(n));
        }
        named(n).into_iter().find_map(|c| self.type_name_of(c))
    }

    fn annotations(&self, modifiers: Node) -> Vec<Annotation> {
        let mut out = Vec::new();
        for c in named(modifiers) {
            match c.kind() {
                "annotation" => out.push(self.annotation(c)),
                "parameter_modifiers" | "modifiers" => out.extend(self.annotations(c)),
                _ => {}
            }
        }
        out
    }

    fn annotation(&self, n: Node) -> Annotation {
        let mut ann = Annotation { line: line(n), ..Default::default() };
        if let Some(ci) = find(n, "constructor_invocation") {
            ann.name = find(ci, "user_type").map(|t| self.user_type_name(t)).unwrap_or_default();
            if let Some(va) = find(ci, "value_arguments") {
                ann.args = named(va).into_iter().filter(|a| a.kind() == "value_argument").map(|a| self.ann_arg(a)).collect();
            }
        } else if let Some(t) = find(n, "user_type") {
            ann.name = self.user_type_name(t);
        }
        ann.name = ann.name.rsplit('.').next().unwrap_or_default().to_string();
        ann
    }

    fn ann_arg(&self, a: Node) -> AnnArg {
        let children = named(a);
        let (name, values) = if children.len() >= 2 && children[0].kind() == "identifier" && has_token(a, "=") {
            (Some(self.text(children[0]).to_string()), &children[1..])
        } else {
            (None, &children[..])
        };
        let mut arg = AnnArg { name, ..Default::default() };
        for v in values {
            self.collect_values(*v, &mut arg);
        }
        arg
    }

    fn collect_values(&self, n: Node, arg: &mut AnnArg) {
        match n.kind() {
            "string_literal" => arg.strings.push(self.string(n)),
            "identifier" => arg.refs.push(self.text(n).to_string()),
            "navigation_expression" => match self.dotted(n) {
                Some(d) => arg.refs.push(d),
                None => named(n).into_iter().for_each(|c| self.collect_values(c, arg)),
            },
            // `Foo::class`
            "callable_reference" | "class_literal" => {
                if let Some(t) = named(n).into_iter().find_map(|c| self.type_name_of(c).or_else(|| (c.kind() == "identifier").then(|| self.text(c).to_string()))) {
                    arg.refs.push(t);
                }
            }
            _ => named(n).into_iter().for_each(|c| self.collect_values(c, arg)),
        }
    }

    /// `a.b.C` when the navigation consists of identifiers only.
    fn dotted(&self, n: Node) -> Option<String> {
        match n.kind() {
            "identifier" => Some(self.text(n).to_string()),
            "navigation_expression" => {
                let parts: Option<Vec<String>> = named(n).into_iter().map(|c| self.dotted(c)).collect();
                parts.map(|p| p.join("."))
            }
            _ => None,
        }
    }

    /// String literal content: escapes decoded, `${...}` templates kept verbatim.
    fn string(&self, n: Node) -> String {
        let mut out = String::new();
        for c in named(n) {
            match c.kind() {
                "string_content" => out.push_str(self.text(c)),
                "escape_sequence" => out.push_str(match self.text(c) {
                    "\\n" => "\n",
                    "\\t" => "\t",
                    "\\r" => "\r",
                    other => &other[1..],
                }),
                _ => out.push_str(self.text(c)),
            }
        }
        out
    }

    fn param(&self, n: Node) -> Param {
        Param {
            name: find(n, "identifier").map(|i| self.text(i).to_string()).unwrap_or_default(),
            type_name: named(n).into_iter().find_map(|c| (c.kind() != "modifiers").then(|| self.type_name_of(c)).flatten()).unwrap_or_default(),
            annotations: named(n).into_iter().filter(|c| c.kind() == "modifiers" || c.kind() == "parameter_modifiers").flat_map(|m| self.annotations(m)).collect(),
        }
    }

    fn function(&self, n: Node) -> Function {
        let annotations = find(n, "modifiers").map(|m| self.annotations(m)).unwrap_or_default();
        let name = named(n).into_iter().filter(|c| c.kind() == "identifier").last().map(|i| self.text(i).to_string()).unwrap_or_default();
        let mut params = Vec::new();
        if let Some(fvp) = find(n, "function_value_parameters") {
            let mut pending = Vec::new();
            for c in named(fvp) {
                match c.kind() {
                    "parameter_modifiers" => pending.extend(self.annotations(c)),
                    "parameter" => {
                        let mut p = self.param(c);
                        p.annotations.splice(0..0, pending.drain(..));
                        params.push(p);
                    }
                    _ => {}
                }
            }
        }
        let body = find(n, "function_body");
        let return_type = named(n).into_iter().find(|c| c.kind() == "user_type" || c.kind() == "nullable_type").and_then(|t| self.type_name_of(t));
        let signature_end_line = body.map(|b| line(b)).unwrap_or_else(|| end_line(n));
        let mut calls = Vec::new();
        if let Some(b) = body {
            self.calls(b, &mut calls);
        }
        Function { name, annotations, params, return_type, start_line: line(n), signature_end_line, end_line: end_line(n), calls }
    }

    fn property(&self, n: Node) -> Property {
        let modifiers_node = find(n, "modifiers");
        let modifiers = modifiers_node
            .map(|m| named(m).into_iter().filter(|c| c.kind() != "annotation").map(|c| self.text(c).to_string()).collect())
            .unwrap_or_default();
        let var = find(n, "variable_declaration");
        Property {
            name: var.and_then(|v| find(v, "identifier")).map(|i| self.text(i).to_string()).unwrap_or_default(),
            type_name: var.and_then(|v| named(v).into_iter().find_map(|c| (c.kind() != "identifier").then(|| self.type_name_of(c)).flatten())),
            annotations: modifiers_node.map(|m| self.annotations(m)).unwrap_or_default(),
            modifiers,
            string_value: find(n, "string_literal").map(|s| self.string(s)),
            line: line(n),
        }
    }

    fn calls(&self, n: Node, out: &mut Vec<Call>) {
        if n.kind() == "call_expression" {
            if let Some(call) = self.call(n) {
                out.push(call);
            }
        }
        // Lambdas and nested declarations inside a body are walked too: their calls belong to the enclosing function.
        for c in named(n) {
            self.calls(c, out);
        }
    }

    fn call(&self, n: Node) -> Option<Call> {
        let callee = n.named_child(0)?;
        let args = self.args(n);
        match callee.kind() {
            "identifier" => Some(Call { receiver: None, method: self.text(callee).to_string(), args, line: line(n), chain: vec![] }),
            "navigation_expression" => {
                let parts = named(callee);
                let (target, method) = (parts.first()?, parts.last()?);
                if method.kind() != "identifier" || parts.len() < 2 {
                    return None;
                }
                let receiver = match target.kind() {
                    "identifier" => self.text(*target).to_string(),
                    // `this.field`
                    "navigation_expression" => {
                        let tp = named(*target);
                        if tp.len() == 2 && tp[0].kind() == "this_expression" && tp[1].kind() == "identifier" {
                            self.text(tp[1]).to_string()
                        } else {
                            return None;
                        }
                    }
                    // Inner link of a chain: recorded in the chain of its base call instead.
                    _ => return None,
                };
                Some(Call { receiver: Some(receiver), method: self.text(*method).to_string(), args, line: line(n), chain: self.chain(n) })
            }
            _ => None,
        }
    }

    /// Calls applied to the result of `call`: parent navigation_expression -> parent call_expression, repeatedly.
    fn chain(&self, call: Node) -> Vec<(String, Vec<Arg>)> {
        let mut out = Vec::new();
        let mut current = call;
        while let Some(nav) = current.parent().filter(|p| p.kind() == "navigation_expression" && p.named_child(0) == Some(current)) {
            let Some(outer) = nav.parent().filter(|p| p.kind() == "call_expression") else { break };
            let Some(method) = named(nav).into_iter().last().filter(|m| m.kind() == "identifier") else { break };
            out.push((self.text(method).to_string(), self.args(outer)));
            current = outer;
        }
        out
    }

    fn args(&self, call: Node) -> Vec<Arg> {
        let Some(va) = find(call, "value_arguments") else { return vec![] };
        named(va)
            .into_iter()
            .filter(|a| a.kind() == "value_argument")
            .map(|a| {
                let children = named(a);
                let value = if children.len() >= 2 && children[0].kind() == "identifier" && has_token(a, "=") { children[1] } else { children[0] };
                self.arg(value)
            })
            .collect()
    }

    fn arg(&self, v: Node) -> Arg {
        let mut arg = Arg::default();
        match v.kind() {
            "string_literal" => arg.string = Some(self.string(v)),
            "identifier" | "navigation_expression" => arg.reference = self.dotted(v),
            "call_expression" => {
                if let Some(callee) = v.named_child(0) {
                    if let Some(name) = self.dotted(callee) {
                        if name.rsplit('.').next().is_some_and(|s| s.starts_with(|c: char| c.is_uppercase())) {
                            arg.constructed = Some(name);
                        }
                    }
                }
            }
            _ => {}
        }
        arg
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SRC: &str = r#"package a.b
import x.y.Z
import org.springframework.web.bind.annotation.*

@RestController
@RequestMapping("/api")
class C(private val s: S, @Value("\${t.x}") private val topic: String) : Base(), Api<Int> {
    @KafkaListener(topics = ["a", Topics.X], groupId = "g")
    fun on(@Payload m: M) {
        val r = this.s.find(1)
        helper(r)
        web.post().uri("/x").retrieve()
        pub.publishEvent(Ev(r))
    }
    companion object {
        const val T = "tt"
    }
}
interface R : JpaRepository<E, Long>
object Topics { const val X = "x.topic" }
"#;

    #[test]
    fn parses_declarations_annotations_and_calls() {
        let f = parse("C.kt", SRC);
        assert_eq!(f.package, "a.b");
        assert_eq!(f.imports.len(), 2);
        assert!(f.imports[1].star);
        let c = f.classes.iter().find(|c| c.name == "C").unwrap();
        assert_eq!(c.fqn, "a.b.C");
        assert_eq!(c.annotation(&["RequestMapping"]).unwrap().values(&["value", "path"]), vec!["/api"]);
        assert_eq!(c.constructor_params[1].annotations[0].values(&["value"]), vec!["${t.x}"]);
        assert_eq!(c.constructor_params[0].type_name, "S");
        assert_eq!(c.supertypes.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), vec!["Base", "Api"]);
        let on = &c.functions[0];
        let kl = &on.annotations[0];
        assert_eq!(kl.values(&["topics"]), vec!["a"]);
        assert_eq!(kl.refs(&["topics"]), vec!["Topics.X"]);
        assert_eq!(on.params[0].type_name, "M");
        let find = |m: &str| on.calls.iter().find(|c| c.method == m).unwrap();
        assert_eq!(find("find").receiver.as_deref(), Some("s"));
        assert_eq!(find("helper").receiver, None);
        let post = find("post");
        assert_eq!(post.chain[0].0, "uri");
        assert_eq!(post.chain[0].1[0].string.as_deref(), Some("/x"));
        assert_eq!(find("publishEvent").args[0].constructed.as_deref(), Some("Ev"));
        assert!(!on.calls.iter().any(|c| c.method == "uri" || c.method == "retrieve"));

        let r = f.classes.iter().find(|c| c.name == "R").unwrap();
        assert_eq!(r.kind, ClassKind::Interface);
        assert_eq!(r.supertypes[0].args, vec!["E", "Long"]);
        assert_eq!(f.constants.get("Topics.X").map(String::as_str), Some("x.topic"));
        assert_eq!(f.constants.get("C.T").map(String::as_str), Some("tt"));
        assert!(f.parse_errors.is_empty());
    }

    #[test]
    fn reports_lines_the_grammar_cannot_parse() {
        let f = parse("E.kt", "class E { companion object { val T = 1 } }
");
        assert_eq!(f.parse_errors, vec![1]);
    }
}

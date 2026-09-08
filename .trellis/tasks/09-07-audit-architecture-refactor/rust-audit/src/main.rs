use std::io::Read;
use quote::ToTokens;
use serde_json::{json, Value};
use syn::visit_mut::{self, VisitMut};
use syn::spanned::Spanned;

struct Inventory {
    scope: Vec<String>,
    methods: Vec<Value>,
    macros: Vec<Value>,
}

struct Formatting;

// 只消除允许省略的末尾逗号，不处理元组等逗号具有语义的结构。
fn trim_comma<T>(values: &mut syn::punctuated::Punctuated<T, syn::Token![,]>) {
    if values.trailing_punct() {
        let last = values.pop().expect("trailing value").into_value();
        values.push_value(last);
    }
}

impl VisitMut for Formatting {
    // 调用实参末尾逗号是排版差异。
    fn visit_expr_call_mut(&mut self, node: &mut syn::ExprCall) {
        visit_mut::visit_expr_call_mut(self, node);
        trim_comma(&mut node.args);
    }
    // 方法调用保持接收者及所有实参，只忽略最后的排版逗号。
    fn visit_expr_method_call_mut(&mut self, node: &mut syn::ExprMethodCall) {
        visit_mut::visit_expr_method_call_mut(self, node);
        trim_comma(&mut node.args);
    }
    // 数组元素不重排，只忽略可选末尾逗号。
    fn visit_expr_array_mut(&mut self, node: &mut syn::ExprArray) {
        visit_mut::visit_expr_array_mut(self, node);
        trim_comma(&mut node.elems);
    }
    // 结构体字段不重排，只忽略可选末尾逗号。
    fn visit_expr_struct_mut(&mut self, node: &mut syn::ExprStruct) {
        visit_mut::visit_expr_struct_mut(self, node);
        trim_comma(&mut node.fields);
    }
    // 比较 Rust 解析后的真实字符串值，不把 raw/转义表示形式当作行为差异。
    fn visit_lit_str_mut(&mut self, node: &mut syn::LitStr) {
        *node = syn::LitStr::new(&node.value(), node.span());
    }
}

impl Inventory {
    // 保留方法完整签名、属性和正文，不执行条件编译或规范化限定路径。
    fn record(&mut self, kind: &str, sig: &syn::Signature, attrs: &[syn::Attribute], body: Option<&syn::Block>) {
        let canonical_body = body.map(|block| {
            let mut block = block.clone();
            Formatting.visit_block_mut(&mut block);
            block.to_token_stream().to_string()
        });
        self.methods.push(json!({
            "kind": kind, "scope": self.scope, "name": sig.ident.to_string(),
            "line": sig.fn_token.span.start().line,
            "end": body.map(|b| b.span().end().line).unwrap_or(sig.span().end().line),
            "signature": sig.to_token_stream().to_string(),
            "attributes": attrs.iter().map(|a| a.to_token_stream().to_string()).collect::<Vec<_>>(),
            "body": body.map(|b| b.to_token_stream().to_string()),
            "canonicalBody": canonical_body,
        }));
    }
}

impl VisitMut for Inventory {
    // 深入内联模块，保留测试和平台条件分支中的声明。
    fn visit_item_mod_mut(&mut self, node: &mut syn::ItemMod) {
        self.scope.push(node.ident.to_string());
        visit_mut::visit_item_mod_mut(self, node);
        self.scope.pop();
    }

    // 用接收类型及可选 trait 标识 impl，避免把同名方法直接合并。
    fn visit_item_impl_mut(&mut self, node: &mut syn::ItemImpl) {
        let trait_name = node.trait_.as_ref().map(|(_, p, _)| p.to_token_stream().to_string());
        self.scope.push(format!("impl {} {:?}", node.self_ty.to_token_stream(), trait_name));
        visit_mut::visit_item_impl_mut(self, node);
        self.scope.pop();
    }

    // 把 trait 声明与默认实现放在所属 trait 下。
    fn visit_item_trait_mut(&mut self, node: &mut syn::ItemTrait) {
        self.scope.push(format!("trait {}", node.ident));
        visit_mut::visit_item_trait_mut(self, node);
        self.scope.pop();
    }

    // 收集自由函数及其内部的具名函数；闭包不伪装成方法。
    fn visit_item_fn_mut(&mut self, node: &mut syn::ItemFn) {
        self.record("function", &node.sig, &node.attrs, Some(&node.block));
        self.scope.push(format!("fn {}", node.sig.ident));
        visit_mut::visit_item_fn_mut(self, node);
        self.scope.pop();
    }

    // 覆盖 inherent impl 和 trait impl，而不只收集顶层自由函数。
    fn visit_impl_item_fn_mut(&mut self, node: &mut syn::ImplItemFn) {
        self.record("method", &node.sig, &node.attrs, Some(&node.block));
        self.scope.push(format!("fn {}", node.sig.ident));
        visit_mut::visit_impl_item_fn_mut(self, node);
        self.scope.pop();
    }

    // 没有默认函数体的 trait 方法也作为需要说明的契约记录。
    fn visit_trait_item_fn_mut(&mut self, node: &mut syn::TraitItemFn) {
        self.record("trait_method", &node.sig, &node.attrs, node.default.as_ref());
        visit_mut::visit_trait_item_fn_mut(self, node);
    }

    // 记录外部函数声明，交由覆盖清单区分系统接口与手写包装器。
    fn visit_foreign_item_fn_mut(&mut self, node: &mut syn::ForeignItemFn) {
        self.record("foreign_declaration", &node.sig, &node.attrs, None);
    }

    // 不展开宏；显式列出带 fn token 的宏，防止误称已覆盖宏生成函数。
    fn visit_macro_mut(&mut self, node: &mut syn::Macro) {
        let tokens = node.tokens.to_string();
        if tokens.split_whitespace().any(|part| part == "fn") {
            self.macros.push(json!({"line": node.span().start().line,
                "path": node.path.to_token_stream().to_string(), "tokens": tokens}));
        }
    }
}

// 从标准输入读取源码快照，输出 JSON 清单；不改写任何受审文件。
fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).expect("read source snapshots");
    let sources: Vec<Value> = serde_json::from_str(&input).expect("snapshot JSON array");
    let mut reports = Vec::new();
    for source in sources {
        let file = source["file"].as_str().expect("file");
        let raw = source["source"].as_str().expect("source");
        let mut parsed = syn::parse_file(raw).unwrap_or_else(|error| panic!("{file}: {error}"));
        let mut inventory = Inventory { scope: Vec::new(), methods: Vec::new(), macros: Vec::new() };
        inventory.visit_file_mut(&mut parsed);
        reports.push(json!({"file": file, "methods": inventory.methods, "unexpanded_macros": inventory.macros}));
    }
    println!("{}", serde_json::to_string(&reports).expect("serialize inventory"));
}

/* 默认名称、顺序和提示词参考所提供扩展的 config/defaults.js；素材和变量来源由新配置接管。 */
window.CustomStepDefaults = [
  {
    "name": "卖点图",
    "key": "111",
    "prompt": "[MODAL_INSTRUCTION]\n步骤一：强制规则（不遵守就重来）\n1、衣服颜色必须和图1一模一样。不准自己改颜色。\n2、衣服款式必须和图1一模一样。衣服占画面15%大小，剩下85%全部留空.\n3、只生成一张图。不准加任何多余的东西。\n4、画面里不准出现人、模特、身体部位。只准出现衣服。\n5、不准出现中文、英文、品牌名、水印、装饰、任何文字。\n6、不准出现任何文字、标点、数字、符号。\n\n步骤二：构图\n2、背景：浅灰色\n3、衣服平铺在画面正中间\n\n步骤三：自检（生成之前必须检查，不合格就重来）\n- 衣服颜色和图1一样吗？不一样 → 重来。\n- 有任何文字吗？有 → 重来。\n- 有任何装饰吗？有 → 重来。\n生成。",
    "upload": "original",
    "imageSource": "product",
    "postprocess": [
      {
        "name": "111扩图.js",
        "code": ""
      },
      {
        "name": "111卖点图后处理.js",
        "code": ""
      }
    ],
    "mappings": []
  },
  {
    "name": "白底图",
    "key": "444",
    "prompt": "把图片里的衣服生成白底图，衣服样式颜色等任何属性都不变，衣服占据的内容只能占据图片整体大小的20%，背景的白底为纯白底色，不得加上任何样式，包括（阴影，描边等）不得出现任何除了纯白以外的其他的颜色。",
    "upload": "original",
    "imageSource": "product",
    "postprocess": [
      {
        "name": "444扩图.js",
        "code": ""
      },
      {
        "name": "444叠加后处理.js",
        "code": ""
      }
    ],
    "mappings": []
  },
  {
    "name": "袖口图",
    "key": "222",
    "prompt": "生成一张纯图片。把样图里袖子边缘那一块裁出来、放大、铺满整个画面。就是样图袖口的局部放大图，颜色、面料纹理、缝线、边缘处理方式和样图一模一样。不准出现任何文字。背景和衣服同色。商品属性：[[材质：{material}；]][[编织方法：{weave}；]][[面料类型：{fabric_type_suffix}；]][[产品特性：{feature}；]][[款式：{style}；]][[袖型：{sleeve}；]][[工艺：{craft_suffix}；]][[克重：{weight}；]][[领型：{collar}；]]",
    "upload": "original",
    "imageSource": "generated",
    "postprocess": [
      {
        "name": "222细节图后处理.js",
        "code": ""
      }
    ],
    "mappings": [
      {
        "variable": "weight",
        "field": ""
      },
      {
        "variable": "weave",
        "field": ""
      },
      {
        "variable": "material",
        "field": ""
      },
      {
        "variable": "fabric_type_suffix",
        "field": ""
      },
      {
        "variable": "feature",
        "field": ""
      },
      {
        "variable": "style",
        "field": ""
      },
      {
        "variable": "collar",
        "field": ""
      },
      {
        "variable": "sleeve",
        "field": ""
      },
      {
        "variable": "craft_suffix",
        "field": ""
      }
    ]
  },
  {
    "name": "面料图",
    "key": "333",
    "prompt": "生成一张纯图片。对准衣服中间区域（胸口到肚子），放大拍面料。只拍衣服中间，不准出现领口、袖口、下摆。衣服平放，面料表面有自然的轻微起伏和褶皱，有立体感和真实的布物质感。面料的颜色、厚薄、光泽、纹理、织法必须和样图一模一样。背景和衣服面料同色。干净清晰电商风。商品属性：[[材质：{material}；]][[编织方法：{weave}；]][[面料类型：{fabric_type_suffix}；]][[产品特性：{feature}；]][[款式：{style}；]][[袖型：{sleeve}；]][[工艺：{craft_suffix}；]][[克重：{weight}；]][[领型：{collar}；]]",
    "upload": "original",
    "imageSource": "generated",
    "postprocess": [
      {
        "name": "333面料图后处理.js",
        "code": ""
      }
    ],
    "mappings": [
      {
        "variable": "weight",
        "field": ""
      },
      {
        "variable": "weave",
        "field": ""
      },
      {
        "variable": "material",
        "field": ""
      },
      {
        "variable": "fabric_type_suffix",
        "field": ""
      },
      {
        "variable": "feature",
        "field": ""
      },
      {
        "variable": "style",
        "field": ""
      },
      {
        "variable": "collar",
        "field": ""
      },
      {
        "variable": "sleeve",
        "field": ""
      },
      {
        "variable": "craft_suffix",
        "field": ""
      }
    ]
  },
  {
    "name": "领口图",
    "key": "666",
    "prompt": "生成一张纯图片。把样图里领口那一块裁出来、放大、铺满整个画面。就是样图领口的局部放大图，领型、层数、缝线、颜色、面料纹理和样图一模一样。不准出现任何文字。纯白背景。商品属性：[[材质：{material}；]][[编织方法：{weave}；]][[面料类型：{fabric_type_suffix}；]][[产品特性：{feature}；]][[款式：{style}；]][[袖型：{sleeve}；]][[工艺：{craft_suffix}；]][[克重：{weight}；]][[领型：{collar}；]]",
    "upload": "original",
    "imageSource": "generated",
    "postprocess": [
      {
        "name": "666领口图后处理.js",
        "code": ""
      }
    ],
    "mappings": [
      {
        "variable": "weight",
        "field": ""
      },
      {
        "variable": "weave",
        "field": ""
      },
      {
        "variable": "material",
        "field": ""
      },
      {
        "variable": "fabric_type_suffix",
        "field": ""
      },
      {
        "variable": "feature",
        "field": ""
      },
      {
        "variable": "style",
        "field": ""
      },
      {
        "variable": "collar",
        "field": ""
      },
      {
        "variable": "sleeve",
        "field": ""
      },
      {
        "variable": "craft_suffix",
        "field": ""
      }
    ]
  }
];

// Curated dish list for the "surprise me" randomiser. Each entry is tagged
// veg / nonveg / either so the randomiser can stay compatible with the
// active Veg / Non-veg / All filter — e.g. never suggest "butter chicken"
// while "Veg" is selected.
export const DISHES = [
  // North Indian — veg
  { name: "paneer tikka", tag: "veg" },
  { name: "paneer butter masala", tag: "veg" },
  { name: "dal makhani", tag: "veg" },
  { name: "chole bhature", tag: "veg" },
  { name: "palak paneer", tag: "veg" },
  { name: "malai kofta", tag: "veg" },
  { name: "aloo paratha", tag: "veg" },
  { name: "rajma chawal", tag: "veg" },
  { name: "kadai paneer", tag: "veg" },
  { name: "paneer lababdar", tag: "veg" },
  { name: "veg pulao", tag: "veg" },
  { name: "shahi paneer", tag: "veg" },

  // North Indian — non-veg
  { name: "butter chicken", tag: "nonveg" },
  { name: "chicken tikka", tag: "nonveg" },
  { name: "chicken tikka masala", tag: "nonveg" },
  { name: "mutton rogan josh", tag: "nonveg" },
  { name: "chicken biryani", tag: "nonveg" },
  { name: "tandoori chicken", tag: "nonveg" },
  { name: "chicken korma", tag: "nonveg" },
  { name: "mutton curry", tag: "nonveg" },
  { name: "chicken seekh kebab", tag: "nonveg" },
  { name: "egg curry", tag: "nonveg" },
  { name: "mutton kebab", tag: "nonveg" },
  { name: "chicken curry", tag: "nonveg" },

  // North/South Indian — either (dish name alone spans both)
  { name: "biryani", tag: "either" },
  { name: "kebab platter", tag: "either" },
  { name: "naan roll", tag: "either" },

  // South Indian — veg
  { name: "masala dosa", tag: "veg" },
  { name: "idli sambar", tag: "veg" },
  { name: "medu vada", tag: "veg" },
  { name: "uttapam", tag: "veg" },
  { name: "rava dosa", tag: "veg" },
  { name: "curd rice", tag: "veg" },

  // South Indian — non-veg
  { name: "chicken chettinad", tag: "nonveg" },
  { name: "fish curry", tag: "nonveg" },
  { name: "hyderabadi mutton biryani", tag: "nonveg" },
  { name: "chicken 65", tag: "nonveg" },
  { name: "prawn curry", tag: "nonveg" },
  { name: "egg dosa", tag: "nonveg" },

  // Indo-Chinese — veg
  { name: "veg fried rice", tag: "veg" },
  { name: "veg manchurian", tag: "veg" },
  { name: "veg hakka noodles", tag: "veg" },
  { name: "paneer chilli", tag: "veg" },
  { name: "veg spring rolls", tag: "veg" },
  { name: "gobi manchurian", tag: "veg" },
  { name: "veg momos", tag: "veg" },

  // Indo-Chinese — non-veg
  { name: "chicken fried rice", tag: "nonveg" },
  { name: "chicken manchurian", tag: "nonveg" },
  { name: "chicken noodles", tag: "nonveg" },
  { name: "chilli chicken", tag: "nonveg" },
  { name: "chicken lollipop", tag: "nonveg" },
  { name: "egg fried rice", tag: "nonveg" },
  { name: "prawn fried rice", tag: "nonveg" },
  { name: "chicken momos", tag: "nonveg" },

  // Indo-Chinese — either
  { name: "fried rice", tag: "either" },
  { name: "noodles", tag: "either" },
  { name: "manchurian", tag: "either" },
  { name: "spring rolls", tag: "either" },
  { name: "momos", tag: "either" },

  // Fast food — veg
  { name: "veg burger", tag: "veg" },
  { name: "margherita pizza", tag: "veg" },
  { name: "cheese pizza", tag: "veg" },
  { name: "french fries", tag: "veg" },
  { name: "veg sandwich", tag: "veg" },
  { name: "paneer wrap", tag: "veg" },
  { name: "grilled cheese sandwich", tag: "veg" },
  { name: "veg loaded nachos", tag: "veg" },

  // Fast food — non-veg
  { name: "chicken burger", tag: "nonveg" },
  { name: "chicken pizza", tag: "nonveg" },
  { name: "pepperoni pizza", tag: "nonveg" },
  { name: "chicken wrap", tag: "nonveg" },
  { name: "chicken sandwich", tag: "nonveg" },
  { name: "chicken nuggets", tag: "nonveg" },
  { name: "hot dog", tag: "nonveg" },
  { name: "buffalo wings", tag: "nonveg" },

  // Italian / Continental — veg
  { name: "pasta arrabbiata", tag: "veg" },
  { name: "alfredo pasta", tag: "veg" },
  { name: "veg lasagna", tag: "veg" },
  { name: "garlic bread", tag: "veg" },
  { name: "mushroom risotto", tag: "veg" },

  // Italian / Continental — non-veg
  { name: "chicken pasta", tag: "nonveg" },
  { name: "chicken lasagna", tag: "nonveg" },
  { name: "chicken alfredo", tag: "nonveg" },

  // Middle Eastern — veg
  { name: "falafel wrap", tag: "veg" },
  { name: "hummus with pita", tag: "veg" },
  { name: "veg shawarma", tag: "veg" },

  // Middle Eastern — non-veg
  { name: "chicken shawarma", tag: "nonveg" },
  { name: "mutton shawarma", tag: "nonveg" },

  // Bengali — veg / non-veg
  { name: "aloo posto", tag: "veg" },
  { name: "cholar dal", tag: "veg" },
  { name: "kosha mangsho", tag: "nonveg" },
  { name: "bengali fish curry", tag: "nonveg" },
];

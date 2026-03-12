// REG-665 verification fixture — exercises C++ language breadth
#include <vector>
#include <string>
#include <memory>
#include <stdexcept>

#define MAX_SIZE 1024
#define SQUARE(x) ((x) * (x))

namespace graphics {

// Forward declaration
class Renderer;

// Enum class (scoped)
enum class Color : int { Red = 0, Green = 1, Blue = 2 };

// Constexpr constant
constexpr int MAX_SHAPES = 100;

// Abstract base class
class [[nodiscard]] Shape {
public:
    virtual ~Shape() = default;
    virtual double area() const = 0;
    virtual std::string name() const { return "Shape"; }

    int id() const { return id_; }

protected:
    int id_ = 0;
};

// Inheritance + templates
template<typename T>
class Circle : public Shape {
public:
    explicit Circle(T radius) : radius_(radius) {}

    double area() const override {
        return 3.14159 * SQUARE(radius_);
    }

    std::string name() const override { return "Circle"; }

    T getRadius() const { return radius_; }

private:
    T radius_;
};

// Multiple inheritance
class ColoredShape : public Shape {
public:
    ColoredShape(Color c) : color_(c) {}
    Color getColor() const { return color_; }

private:
    Color color_;
};

// Struct with bit fields
struct RenderOptions {
    unsigned int antialiasing : 1;
    unsigned int vsync : 1;
    unsigned int fullscreen : 1;
    int width = 800;
    int height = 600;
};

// Union
union Pixel {
    struct { unsigned char r, g, b, a; } channels;
    unsigned int packed;
};

// Typedef and using alias
typedef std::vector<std::unique_ptr<Shape>> ShapeList;
using ShapePtr = std::unique_ptr<Shape>;

// Free function with various qualifiers
static inline constexpr int maxDimension() noexcept {
    return MAX_SIZE;
}

// Function template
template<typename T>
T clamp(T value, T low, T high) {
    if (value < low) return low;
    if (value > high) return high;
    return value;
}

// Operator overloading
class Vec2 {
public:
    double x, y;

    Vec2 operator+(const Vec2& other) const {
        return {x + other.x, y + other.y};
    }

    bool operator==(const Vec2& other) const {
        return x == other.x && y == other.y;
    }
};

// Exception hierarchy
class RenderError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

// Class with constructor variants
class Renderer {
public:
    Renderer() = default;
    Renderer(const Renderer&) = delete;
    Renderer(Renderer&&) noexcept = default;

    explicit Renderer(const RenderOptions& opts) : options_(opts) {}

    void render(const ShapeList& shapes) {
        try {
            for (const auto& shape : shapes) {
                if (!shape) {
                    throw RenderError("null shape");
                }
                double a = shape->area();
                processArea(a);
            }
        } catch (const RenderError& e) {
            handleError(e);
        } catch (...) {
            handleUnknown();
        }
    }

    // Lambda usage
    void sortShapes(ShapeList& shapes) {
        auto comparator = [this](const ShapePtr& a, const ShapePtr& b) {
            return a->area() < b->area();
        };
        // would call std::sort with comparator
    }

    // Static method
    static Renderer* createDefault() {
        static Renderer instance;
        return &instance;
    }

private:
    void processArea(double area) {
        if (area > static_cast<double>(maxDimension())) {
            auto* ptr = new Circle<double>(area);
            delete ptr;
        } else {
            area = 0.0;
        }
    }

    void handleError(const RenderError& e) {}
    void handleUnknown() {}

    RenderOptions options_;
    std::vector<Vec2> vertices_;
};

} // namespace graphics

// Global variable
static int g_frameCount = 0;

// Main with various constructs
int main() {
    using namespace graphics;

    auto circle = std::make_unique<Circle<double>>(5.0);
    ShapeList shapes;
    shapes.push_back(std::move(circle));

    RenderOptions opts{};
    opts.antialiasing = 1;
    opts.width = 1920;

    Renderer renderer(opts);
    renderer.render(shapes);

    Pixel p{};
    p.channels.r = 255;

    Vec2 a{1.0, 2.0};
    Vec2 b{3.0, 4.0};
    Vec2 c = a + b;

    int val = clamp(42, 0, 100);

    Color color = Color::Red;

    switch (color) {
    case Color::Red:
        g_frameCount++;
        break;
    case Color::Green:
    case Color::Blue:
        break;
    default:
        val = -1;
        break;
    }

    // Range-for over plain array (no system headers needed)
    int arr[] = {1, 2, 3, 4, 5};
    for (int x : arr) {
        val += x;
    }

    for (int i = 0; i < 10; ++i) {
        val = SQUARE(i);
    }

    return 0;
}
